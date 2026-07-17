# Genius API / 設定

## HTTP API (port 4230, Hono)

| Method | Path | 説明 |
|---|---|---|
| GET | `/healthz` | `{ok, model, cards, ollama}` (Ollama 死活も返す) |
| POST | `/api/clone/query` | `{text, domain?, visibility?, k?=8}` → `{cards:[{...card, score}], tookMs}` |
| GET | `/api/clone/cards` | 一覧。`?domain=&visibility=&tag=&q=&limit=&offset=` (q は LIKE) |
| GET | `/api/clone/cards/:id` | 単体 |
| POST | `/api/clone/cards` | 手動カード追加 (public は保存直前に共通センシティブ検査) |
| PATCH | `/api/clone/cards/:id` | 本文修正 / supersede / 象限訂正 (訂正時は再埋め込み) |
| POST | `/api/clone/ingest/run` | `{sources?: string[], tier2?: boolean, budgetFiles?: number, allowMissing?: boolean}` → run id (非同期実行) |
| GET | `/api/clone/ingest/runs/:id` | 実行状況 (distill_runs) |
| GET | `/api/clone/stats` | 象限別カード数 / tier 別 / 最終 ingest |
| GET | `/api/clone/export` | `?visibility=public` — public カードの JSON export (datahub push 用素材。push 自体はスコープ外) |

- DELETE は提供しない (supersede で代替)。
- 認証なし (127.0.0.1 bind のみ。0.0.0.0 で listen しない)。

## CLI

```
genius query "<text>" [--domain work|hobby] [--visibility public|sensitive] [-k 8]
genius ingest [--sources memory,review] [--tier2] [--budget-files 500] [--allow-missing]
genius stats
genius reembed --model <name>   # モデル移行バッチ
```

## MCP server (stdio)

tool: `genius_query { text, domain?, visibility?: "public", k? }`。外部モデル文脈への
機微情報混入を防ぐため public 固定で、`sourceRef`・内部 ID・時刻を除く安全 DTO を返す。

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
    "numGpu": null // null = Ollama 既定。0 = 明示的 CPU 実行
  },
  "distill": {
    "backend": "claude-cli",            // "claude-cli" | "ollama"
    "model": "claude-haiku-4-5-20251001",
    "sensitiveCheckModel": "claude-haiku-4-5-20251001",
    "ollamaModel": "gemma4:12b"          // backend=ollama 時
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
