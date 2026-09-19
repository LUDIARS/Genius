# 設定リファレンス

ローカル正本は `genius.config.json` です (`genius.config.example.json` をコピーして作る。
個人パスを含むため gitignore 対象)。相対ディレクトリは設定ファイルのあるディレクトリを
基準に解決されます。ソースを `null` にすると無効になり、選択 ingest 時は明示エラーに
なります。意図した欠損だけ `--allow-missing` で警告付きスキップできます。

## 環境変数 override

サービス設定の環境変数 override は次のとおりです。空文字や不正値は fail-fast します。

| 環境変数 | 対象 |
|---|---|
| `GENIUS_PORT` | HTTP port |
| `GENIUS_BIND_HOST` | 待ち受け interface。既定 `127.0.0.1`、公開するなら `0.0.0.0` |
| `GENIUS_ALLOWED_ORIGINS` | loopback 以外に許可する origin。カンマ区切りの完全一致 |
| `GENIUS_DATA_DIR` | SQLite と派生データの保存ディレクトリ |
| `GENIUS_EMBEDDING_BASE_URL` | Ollama embedding URL (loopback のみ) |
| `GENIUS_EMBEDDING_MODEL` | embedding model |
| `GENIUS_EMBEDDING_DIM` | embedding 次元。現行 schema は 1024 固定 |
| `GENIUS_EMBEDDING_NUM_GPU` | Ollama `num_gpu`。未指定は Ollama 既定、`0` は明示的 CPU 実行 |
| `GENIUS_EMBEDDING_KEEP_ALIVE` | Ollama のモデル常駐時間 (例 `"30m"`) |
| `GENIUS_DISTILL_BACKEND` | `claude-cli` または `ollama` |
| `GENIUS_DISTILL_MODEL` | Claude CLI 蒸留 model |
| `GENIUS_DISTILL_SENSITIVE_CHECK_MODEL` | public 二重チェック用 Claude model |
| `GENIUS_DISTILL_OLLAMA_MODEL` | Ollama 蒸留 model |
| `GENIUS_SOURCE_MEMORY_DIR` | memory MD ディレクトリ |
| `GENIUS_SOURCE_SESSION_LOGS_DIR` | session-logs ディレクトリ |
| `GENIUS_SOURCE_CHANNEL_ARCHIVES_DIR` | Concordia channel archive ディレクトリ |
| `GENIUS_SOURCE_REVIEW_DIR` | Review 成果物ディレクトリ |
| `GENIUS_SOURCE_CLAUDE_PROJECTS_DIR` | Claude JSONL ディレクトリ (Tier 2) |
| `GENIUS_SOURCE_CODEX_SESSIONS_DIR` | Codex JSONL ディレクトリ (Tier 2) |
| `GENIUS_SOURCE_MEMORIA_BASE_URL` | Memoria API URL |
| `GENIUS_NOTIFY_CONCORDIA_BASE_URL` | 失敗 run 通知先の Concordia base URL (loopback のみ) |

## クライアント側

MCP、hook、eval などの HTTP クライアントは `GENIUS_BASE_URL` で明示的な loopback URL を
指定できます。未指定時はカレントディレクトリの `genius.config.json` を読みます。
hook に限り、`GENIUS_CONFIG_PATH` で config の場所を指定できます。

## Port と Excubitor catalog

`genius.config.example.json` と設計書では 4230 を使用しています。サービス port と endpoint の
正本は Excubitor catalog / ProcessMap であり、登録値と `genius.config.json` を一致させて
ください。実装セッションや worktree からサービスを直接 spawn しません。

設定ファイルの全キーと API の body / response は [`spec/interface/api.md`](../interface/api.md) を参照。
