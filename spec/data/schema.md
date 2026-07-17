# Genius DB スキーマ

DB: `data/genius.db` (better-sqlite3, WAL)。migration は番号連番 + 冪等
(`IF NOT EXISTS`)。`DROP TABLE` / `DROP COLUMN` / 型変更禁止 (LUDIARS 共通)。

## clone_cards — 判断カード (正)

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT PK | ULID |
| domain | TEXT | `work` \| `hobby` |
| visibility | TEXT | `public` \| `sensitive` |
| situation | TEXT | どういう場面か (一般化した記述) |
| judgment | TEXT | 私ならこうする |
| rationale | TEXT | なぜか |
| tags | TEXT | JSON 配列文字列 |
| source_ref | TEXT | 出典追跡子 (`<reader>:<path or id>#<anchor>`) |
| source_tier | INTEGER | 1 \| 2 |
| confidence | REAL | 蒸留 LLM の自信 0..1 |
| superseded_by | TEXT NULL | 統合/更新先カード id (削除の代替) |
| created_at / updated_at | INTEGER | epoch ms |

インデックス: `(domain, visibility)`, `(superseded_by)`, `UNIQUE (source_ref)`。

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
