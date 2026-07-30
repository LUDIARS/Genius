# Genius API / 設定

## HTTP API (port 4230, Hono)

| Method | Path | 説明 |
|---|---|---|
| GET | `/healthz` | `{ok, model, cards, ollama}` (Ollama 死活も返す) |
| POST | `/api/clone/query` | `{text, domain?, visibility?, categories?, k?=8}` → `{cards:[{...card, score}], tookMs}` (`categories` は統制語彙の OR フィルタ。統制外の値は 400) |
| POST | `/api/clone/query-batch` | `{queries: [{text, domain?, visibility?, categories?, k?=8}, ...]}` → `{results: [{cards, tookMs}, ...]}` (1〜N クエリを 1 回の embed 呼び出しに集約。p95 改善策、上限50件) |
| GET | `/api/clone/cards` | 一覧。`?domain=&visibility=&category=&tag=&q=&limit=&offset=` (q は LIKE。category は統制語彙、統制外は 400) |
| GET | `/api/clone/cards/:id` | 単体 |
| POST | `/api/clone/cards` | 手動カード追加 (public は保存直前に共通センシティブ検査。`category?` は統制語彙、統制外は 400) |
| PATCH | `/api/clone/cards/:id` | 本文修正 / supersede / 象限・category 訂正 (訂正時は再埋め込み)。body に `changedBy?: "ui"\|"api"\|"cli"` (既定 `api`)。象限/category 変更は `clone_card_revisions` に列名のみ記録。**昇格 (sensitive→public) は `LlmPublicCardGate` を再実行し、sensitive 判定なら 409 で拒否** (無言降格しない)。降格は無条件許可 |
| GET | `/api/clone/categories` | カテゴリー統制語彙の一覧 → `{categories: [{name, description, createdAt}]}` |
| POST | `/api/clone/categories` | カテゴリー追加 `{name, description}` → 201。重複は 409。DELETE は提供しない |
| POST | `/api/clone/ingest/run` | `{sources?: string[], tier2?: boolean, budgetFiles?: number, allowMissing?: boolean, retryFailed?: boolean}` → run id (非同期実行)。`budgetFiles` は `tier2=true` の時のみ指定可・未指定は上限なし (全未読ファイル)、明示時のみ Tier 2 の読み取り上限。`retryFailed=true` は `ingest_failures` の未解決文書だけをカーソル無関係に再処理する (`budgetFiles` と併用不可) |
| GET | `/api/clone/ingest/runs/:id` | 実行状況 (distill_runs)。`status` は `running \| completed \| completed-with-errors \| failed` の 4 値 union — **「completed 以外は失敗」と判定しない** (`completed-with-errors` は正常終了扱い)。`failedDocuments` (この run で隔離された失敗文書数) と `unresolvedFailures` (run 対象ソースの未解決失敗件数) を含む |
| GET | `/api/clone/stats` | 象限別カード数 / tier 別 / 最終 ingest / `unresolvedIngestFailures` (全ソースの未解決失敗件数) |
| GET | `/api/clone/export` | `?visibility=public[&category=]` — public カードの JSON export (datahub push 用素材。push 自体はスコープ外。category は統制語彙、統制外は 400) |

- DELETE は提供しない (supersede で代替。カテゴリーも削除不可)。
- 認証なし (127.0.0.1 bind のみ。0.0.0.0 で listen しない)。

## CLI

```
genius query "<text>" [--domain work|hobby] [--visibility public|sensitive] [--categories a,b] [-k 8]
genius ingest [--sources memory,review] [--tier2 [--budget-files 500]] [--allow-missing] [--retry-failed]
# --budget-files は --tier2 と組でのみ指定可。未指定 = 上限なし (全未読ファイル)
# --retry-failed は未解決の失敗文書だけを再処理する (--budget-files と併用不可)
genius stats
genius reembed --model <name>   # モデル移行バッチ
genius categorize --missing     # category NULL のカードを安価パスで分類する backfill
```

`categorize --missing` は再蒸留・再 embedding を行わず、既存カード本文
(situation+judgment) を蒸留 backend の安価パス (sensitiveCheckModel 相当) で
統制語彙 1 値に分類し、進捗を stdout に出す。

## MCP server (stdio)

tool: `genius_query { text, domain?, visibility?: "public", categories?, k? }`。外部モデル文脈への
機微情報混入を防ぐため public 固定で、`sourceRef`・内部 ID・時刻を除く安全 DTO を返す。
`categories` は統制語彙の OR フィルタ (セッションの LLM が自タスクのカテゴリーを渡す —
spec/feature/operations.md §1.3)。

## Harness hook (`hooks/genius-supply.mjs`)

stdin はプレーンテキスト prompt (後方互換) に加えて JSON
`{"prompt": "...", "categories": ["..."]}` も受け付ける。JSON object として
パースできて形が不正な場合はエラー (無言でプレーンテキスト扱いしない)。

## 設定 — genius.config.json (gitignore, ローカル正本)

`genius.config.example.json` をコミットし、実体はローカルにコピーして使う。
loader は「example しか無い場合は起動エラー + コピー手順を表示」(無言
フォールバック禁止)。env override 許容 (`GENIUS_PORT` 等)、既定値はファイル。

```jsonc
{
  "port": 4230,
  "dataDir": "./data",
  "embedding": {
    "baseUrl": "http://127.0.0.1:11434",
    "model": "bge-m3",
    "dim": 1024,
    "numGpu": null, // null = Ollama 既定。0 = 明示的 CPU 実行
    "keepAlive": null // 例 "30m"。null = Ollama 既定 (5分)。broken GPU 環境で
                       // モデルがアンロードされるたびの再ロード遅延を避けたい時に設定
  },
  "distill": {
    "backend": "claude-cli",            // "claude-cli" | "ollama"
    "model": "claude-haiku-4-5-20251001",
    "sensitiveCheckModel": "claude-haiku-4-5-20251001",
    "ollamaModel": "gemma4:12b"          // backend=ollama 時
  },
  "notify": {
    "concordiaBaseUrl": null    // 失敗 run (failed / completed-with-errors) の通知先
                                 // Concordia base URL。loopback のみ許可。
                                 // null = 通知無効 (起動時に 1 行明示)
  },
  "sources": {
    "memoryDir": null,          // 例 C:/Users/<user>/.claude/projects/<proj>/memory
    "sessionLogsDir": null,     // 例 E:/Document/Ars/session-logs
    "channelArchivesDir": null, // 例 E:/Document/Ars/Concordia/logs/channel-archives
    "reviewDir": null,          // 例 E:/Document/Ars/Review
    "claudeProjectsDir": null,  // Tier2: C:/Users/<user>/.claude/projects
    "codexSessionsDir": null,   // Tier2: C:/Users/<user>/.codex/sessions
    "memoriaBaseUrl": null      // 例 http://127.0.0.1:5180
  }
}
```

- `null` のソースは無効。ingest 指定時は明示エラー (`--allow-missing` でのみ
  スキップ+警告出力)。
- 個人絶対パスをソースコードへハードコードしない (HARNESS 地雷ルール)。
- `GENIUS_EMBEDDING_NUM_GPU` で `numGpu` を明示 override できる。自動 CPU
  フォールバックは行わない。
- `GENIUS_NOTIFY_CONCORDIA_BASE_URL` で `notify.concordiaBaseUrl` を override できる。
  通知 payload は run id・ソース名・失敗件数・エラー種別/メッセージ要約・
  ソース相対パスのみ。文書本文・カード本文・絶対パスは載せない
  (spec/feature/operations.md §4)。
- `GENIUS_EMBEDDING_KEEP_ALIVE` で `keepAlive` を明示 override できる
  (Ollama `keep_alive`)。GPU 自動検出が壊れたホストでモデルがアンロード
  された後の再ロードが GPU 経路をまず試みて数秒〜十数秒詰まる事例を確認済み
  (spec/feature/clone-db.md セクション 6)。運用ではモデル常駐を保つ値を推奨。
