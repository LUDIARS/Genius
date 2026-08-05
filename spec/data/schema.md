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
| retired_at | INTEGER NULL | 置換先なしで非活性化した時刻 (epoch ms)。NULL = 非 retire。`superseded_by` とは独立で、どちらか片方でも「活性」から外れる |
| created_at / updated_at | INTEGER | epoch ms |

インデックス: `(domain, visibility)`, `(superseded_by)`, `(category)`,
`(retired_at) WHERE retired_at IS NOT NULL` (部分索引 — 活性判定は
`retired_at IS NULL` 側でほぼ全行に一致し索引の利得がないため、retire 済みだけを
索引する), `UNIQUE (source_ref)`。

### 「活性カード」の定義 (正)

活性 = `superseded_by IS NULL AND retired_at IS NULL`。この条件は
`src/cards/active-card-sql.ts` に**一元定義**し、一覧・件数・vector 検索・
query port・蒸留の重複判定・公開 export はすべてそこから参照する
(条件のコピーを増やさない — 1 箇所漏れると retire 済みカードが検索や公開 export に
戻る)。一覧 API だけは棚卸し用途のため `includeSuperseded` / `includeRetired` で
2 条件を個別に外せる。

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

PATCH による象限 (domain/visibility)・category・retire (retired_at) 変更の監査記録。変更された**列名**のみ
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
  clone_cards JOIN で象限/活性 (supersede + retire) フィルタ → 上位 k」の 2 段で行う。

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

## query_log — 検索ミス計測 (migration 005)

補完質問の retrieval-miss 検出 (spec/feature/active-questioning.md §1.2)。
**判断ではなく生のクエリ文**なのでカードと扱いを分ける: 公開 export に含めない・
カード DTO に出さない・WebUI の質問画面でのみ参照する。保持期間
(`queryLog.retentionDays`, 既定 30 日) をサーバ起動時と ingest 完了後に強制する。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT PK | ULID |
| text | TEXT | 生のクエリ文 |
| domain | TEXT NULL | クエリの domain フィルタ (`work` / `hobby`) |
| visibility | TEXT NULL | クエリの visibility フィルタ (`public` / `sensitive`) |
| categories | TEXT NULL | クエリの categories フィルタ (JSON 配列) |
| top_similarity | REAL NULL | top1 のセマンティック類似度 (1 / (1 + distance))。0 件なら NULL |
| result_count | INTEGER | 返した件数 |
| created_at | INTEGER | epoch ms |

## questions / question_targets / question_answers — 補完質問 (migration 006 + 007)

能動学習の質問キュー (spec/feature/active-questioning.md §2.1)。統制語彙
(gap_kind / status / target_kind / answered_via) は CHECK で fail-fast。

### questions

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT PK | ULID |
| question | TEXT | 訊く内容 |
| context | TEXT | なぜ訊くのかの 1 行 |
| category | TEXT | `card_categories` 参照 |
| domain | TEXT | `work` / `hobby` |
| visibility | TEXT | `public` / `sensitive` (二重チェックゲート通過値。public のみ Discord 可) |
| gap_kind | TEXT | `low-confidence` / `contradiction` / `category-gap` / `retrieval-miss` / `curation` |
| status | TEXT | `open` / `answered` / `dismissed` (既定 `open`) |
| asked_at | INTEGER NULL | Discord へ送った時刻。WebUI のみなら NULL |
| answered_at | INTEGER NULL | 回答時刻 |
| discord_message_id | TEXT NULL | Concordia chat の message id |
| created_at | INTEGER | epoch ms |

### question_targets

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT PK | ULID |
| question_id | TEXT | `questions` 参照 |
| target_kind | TEXT | `card` / `card-context` / `card-pair` / `query_log` / `category` |
| target_id | TEXT | カード id / 昇順連結ペア id / query_log id / category 名 |

`card-context` は矛盾質問の表示根拠で、同じカードが別ペアにも参加できるため重複可。
`card` / `card-pair` / `query_log` / `category` には部分 UNIQUE index
`idx_question_targets_dedupe` を張り、同じ対象を再質問しない判定の実体にする。

### question_answers

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT PK | ULID |
| question_id | TEXT | `questions` 参照 |
| text | TEXT | 元の回答文 (整形前を残す) |
| answered_via | TEXT | `ui` / `discord` |
| card_id | TEXT NULL | 回答から生成されたカード |
| created_at | INTEGER | epoch ms |

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
| query_log | user | Genius | ローカル SQLite | 必要 | loopback のみ。公開 export 禁止・カード DTO に出さない・保持期間付き (既定 30 日) |
| questions / answers | user | Genius | ローカル SQLite | 必要 | loopback のみ。public 判定の質問だけ Discord へ送出可 |

カード本文は neco 個人の判断記録であり、この DB 自体がローカル限定の個人
ストア (Cernere の単一情報源ルールの対象外 — 氏名/email/認証情報は扱わない。
万一ソースに含まれても蒸留時にカードへ**転記しない**ことをプロンプトで指示)。
