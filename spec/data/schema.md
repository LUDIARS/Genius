# Genius DB スキーマ

DB: `data/genius.db` (better-sqlite3, WAL)。migration は番号連番 + 冪等
(`IF NOT EXISTS`)。`DROP TABLE` / `DROP COLUMN` / 型変更禁止 (LUDIARS 共通)。

## clone_cards — 判断カード (正)

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT PK | ULID |
| domain | TEXT | `work` \| `hobby` |
| visibility | TEXT | `public` \| `sensitive` |
| category | TEXT NULL | 統制語彙 (`card_categories.name`)。NULL = 未分類 (backfill 前)。trigger で統制外値を reject |
| situation | TEXT | どういう場面か (一般化した記述) |
| judgment | TEXT | 私ならこうする |
| rationale | TEXT | なぜか |
| tags | TEXT | JSON 配列文字列 |
| source_ref | TEXT | 出典追跡子 (`<reader>:<path or id>#<anchor>`) |
| source_tier | INTEGER | 1 \| 2 |
| confidence | REAL | 蒸留 LLM の自信 0..1 |
| superseded_by | TEXT NULL | 統合/更新先カード id (削除の代替) |
| created_at / updated_at | INTEGER | epoch ms |

インデックス: `(domain, visibility)`, `(superseded_by)`, `(category)`, `UNIQUE (source_ref)`。

## card_categories — カテゴリー統制語彙 (正)

実行時の統制語彙の正本 (spec/feature/operations.md §1.1)。蒸留プロンプトの語彙リストは
起動時にこのテーブルから生成する (プロンプトへのベタ書き禁止)。DELETE は提供しない。

| 列 | 型 | 説明 |
|---|---|---|
| name | TEXT PK | カテゴリー名 (例 `impl-design`) |
| description | TEXT | 説明 (プロンプト語彙リストに使用) |
| created_at | INTEGER | epoch ms |

初期セット (migration 002 で seed): `impl-design` / `review` / `ops-lifecycle` /
`delegation` / `writing` / `data-privacy` / `workflow` / `general` (既定)。
`clone_cards.category` は trigger で統制語彙外の値を reject する。

## clone_card_revisions — カード変更履歴

PATCH による象限 (domain/visibility)・category 変更の監査記録。変更された**列名**のみ
保持し、本文差分は保存しない (revisions 経由でセンシティブ本文を増殖させない —
spec/feature/operations.md §2)。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT PK | ULID |
| card_id | TEXT | 対象カード id |
| changed_fields | TEXT | 変更列名の JSON 配列 (値は含めない) |
| changed_by | TEXT | `ui` \| `api` \| `cli` (認証がないため呼び出し元識別子) |
| changed_at | INTEGER | epoch ms |

インデックス: `(card_id)`。

## clone_vec — ベクトル索引 (派生キャッシュ)

sqlite-vec vec0 仮想テーブル:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS clone_vec USING vec0(
  card_id TEXT PRIMARY KEY,
  embedding float[1024]
);
```

- 埋め込み対象テキスト = `situation + "\n" + judgment + "\n" + rationale`。
- vec0 は WHERE 句フィルタが弱いため、検索は「vec0 KNN (k×4 取得) →
  clone_cards JOIN で象限/supersede フィルタ → 上位 k」の 2 段で行う。

## embedding_meta — 埋め込みモデル管理

| 列 | 型 | 説明 |
|---|---|---|
| model | TEXT PK | 例 `bge-m3` |
| dim | INTEGER | 1024 |
| is_active | INTEGER | 現行モデル = 1 (常に 1 行のみ) |

モデル移行 = 新モデルで全カード再埋め込みバッチ → `is_active` 切替。

## ingest_state — 増分カーソル

| 列 | 型 | 説明 |
|---|---|---|
| source | TEXT PK | `memory` / `session-logs` / `channel-archives` / `review` / `memoria` / `claude-jsonl` / `codex-jsonl` |
| cursor | TEXT | 最終処理位置 (mtime + パス の JSON) |
| updated_at | INTEGER | |

## distill_runs — 実行記録

| 列 | 型 |
|---|---|
| id | TEXT PK (ULID) |
| source | TEXT |
| files_processed / cards_created / cards_merged / skipped | INTEGER |
| started_at / finished_at | INTEGER |
| notes | TEXT |

`notes` は `{status, error, failedDocuments}` の JSON。`status` は
`running | completed | completed-with-errors | failed` の 4 値
(migration 002 以前の行は `failedDocuments` 欠落 = 0 扱い)。

## ingest_failures — 失敗文書 (migration 002)

文書単位のエラー隔離 (spec/feature/operations.md §4)。カーソルが失敗文書を
追い越しても `--retry-failed` で再処理できるよう永続化する。**本文は保存しない**
(`error_message` は bounded な分類済みメッセージのみ)。

| 列 | 型 | 説明 |
|---|---|---|
| source | TEXT | ソース名 (ingest_state と同じ統制値) |
| locator | TEXT | ソース相対パス / API キー (絶対パス禁止) |
| mtime_ms | INTEGER | 失敗時点の文書 mtime |
| native_id | TEXT NULL | reader 私有の安定 ID (review の manifest locator / Memoria の API パス)。retry 時の descriptor 復元用。絶対パス禁止 |
| run_id | TEXT | 最後に失敗した run |
| error_kind | TEXT | `source-read-failed` / `embedding-failed` / `distillation-output-invalid` / `processing-failed` |
| error_message | TEXT | 本文を含まない要約 (管理外の例外はエラー名のみ) |
| failed_at | INTEGER | 最終失敗時刻 (epoch ms) |
| resolved_at | INTEGER NULL | 再処理成功時に設定。NULL = 未解決 |

PK は `(source, locator)` — 再失敗は同一行を上書きし `resolved_at` を NULL に戻す。
部分インデックス `idx_ingest_failures_unresolved` (`resolved_at IS NULL`)。

## 派生キャッシュ

`embedding_cache` は task-02 の content-addressed cache。テキスト本文は保存せず、
SHA-256・model・format version とベクトルだけを保持する。カード本文が常に正であり、
キャッシュは削除・再生成可能。

## データ分類と保護

| データ | 種類 | 権威ソース | 保存先 | 保護 | 方針 |
|---|---|---|---|---|---|
| 判断カード | user | `clone_cards` 本文 | ローカル SQLite | 必要 | loopback のみ。外部 embedding 禁止。ログへ本文を出さない |
| ベクトル | derived | 判断カード | `clone_vec` | 必要 | ローカル SQLite。再生成可能 |
| ingest cursor/run | operational | Genius | ローカル SQLite | 必要 | source_ref/path を公開 export へ含めない |
| embedding cache | derived | 判断カード | ローカル SQLite | 必要 | 原文を保存せず hash と vector のみ |

カード本文は neco 個人の判断記録であり、この DB 自体がローカル限定の個人
ストア (Cernere の単一情報源ルールの対象外 — 氏名/email/認証情報は扱わない。
万一ソースに含まれても蒸留時にカードへ**転記しない**ことをプロンプトで指示)。
