# Genius — 自分クローン判断カード DB

Genius は、過去の作業記録から「この場面ならどう判断するか」を判断カード
(場面・判断・理由) に蒸留し、Claude / Codex へ検索結果を供給するローカルサービスです。
真の fine-tuning ではなく、関連する判断カードを top-k で注入する
retrieval-conditioned judgment (擬似 FT) を採用します。

- 四象限: `domain: work|hobby` × `visibility: public|sensitive`
- HTTP: Hono、loopback bind のみ
- DB: better-sqlite3 + sqlite-vec (`data/genius.db`、gitignore)
- 埋め込み: ローカル Ollama `bge-m3`、1024 次元
- 蒸留: `claude-cli` またはローカル Ollama

## セキュリティ境界

- 埋め込みは全象限ともローカル Ollama のみです。外部 embedding URL は設定時に拒否します。
- HTTP API とクライアント接続先は loopback のみに制限されます。認証機能はないため、
  reverse proxy や `0.0.0.0` bind で公開しないでください。
- ソースリーダは読み取り専用です。元データを移動・更新・削除しません。
- `data/`、`logs/`、`genius.config.json` はコミットしません。公開 export は
  `visibility=public` の active カードだけを返し、`sourceRef` を含めません。
- Claude / Codex へ接続する MCP と harness hook も public 固定で、`sourceRef`、内部 ID、
  時刻を除く安全 DTO だけを返します。sensitive 検索は loopback HTTP API / ローカル CLI
  の明示操作に限定します。
- `claude-cli` 蒸留は Claude CLI の信頼境界へ原文を渡します。外部送信できない素材を
  ingest する運用では、事前に `distill.backend` を `ollama` に切り替えてください。
  Claude 実行時は tools・MCP・skills・session persistence を無効化します。backend の
  自動フォールバックはありません。

## クイックスタート

前提は Node.js 22+、npm、Ollama です。既定の蒸留 backend を使う場合は、
認証済みの `claude` CLI も必要です。

```text
ollama pull bge-m3
npm ci --include=dev
```

設定ファイルを作成します。PowerShell では次を使います。

```powershell
Copy-Item -LiteralPath genius.config.example.json -Destination genius.config.json
```

POSIX shell では次を使います。

```sh
cp genius.config.example.json genius.config.json
```

`genius.config.json` のソースパスをローカル環境に合わせて編集した後、build、migration、
テストを実行します。

```text
npm run build
npm run migrate
npm test
```

サービス起動は共有 worktree や実装セッションから行わず、Excubitor または人間が
プロジェクト本体で行います。開発時は `npm run dev`、build 済み成果物は `npm start` です。
起動後は、設定した port の `/healthz` を確認します。example の port は 4230 です。

```text
curl http://127.0.0.1:4230/healthz
```

PowerShell の場合:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:4230/healthz
```

## 設定

ローカル正本は `genius.config.json` です。相対ディレクトリは設定ファイルのある
ディレクトリを基準に解決されます。ソースを `null` にすると無効になり、選択 ingest 時は
明示エラーになります。意図した欠損だけ `--allow-missing` で警告付きスキップできます。

サービス設定の環境変数 override は次のとおりです。空文字や不正値は fail-fast します。

| 環境変数 | 対象 |
|---|---|
| `GENIUS_PORT` | HTTP port |
| `GENIUS_DATA_DIR` | SQLite と派生データの保存ディレクトリ |
| `GENIUS_EMBEDDING_BASE_URL` | Ollama embedding URL (loopback のみ) |
| `GENIUS_EMBEDDING_MODEL` | embedding model |
| `GENIUS_EMBEDDING_DIM` | embedding 次元。現行 schema は 1024 固定 |
| `GENIUS_EMBEDDING_NUM_GPU` | Ollama `num_gpu`。未指定は Ollama 既定、`0` は明示的 CPU 実行 |
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

MCP、hook、eval などの HTTP クライアントは `GENIUS_BASE_URL` で明示的な loopback URL を
指定できます。未指定時はカレントディレクトリの `genius.config.json` を読みます。
hook に限り、`GENIUS_CONFIG_PATH` で config の場所を指定できます。

## CLI

fresh checkout で常に成立する呼び出しは、build 後の `node dist/cli.js` です。

```text
node dist/cli.js query "判断したい内容" --domain work --visibility public -k 8
node dist/cli.js ingest
node dist/cli.js stats
node dist/cli.js reembed --model <new-local-model>
```

短い `genius` コマンドが必要なら、build 後に任意で `npm link` してください。
CLI の `query`、`ingest`、`stats` は起動中の Genius API を利用します。

## Ingest と Tier

引数なしの ingest 対象は Tier 1 のみです。

- `memory`
- `session-logs`
- `channel-archives`
- `review`
- `memoria`

```text
node dist/cli.js ingest
```

一部だけ投入する場合:

```text
node dist/cli.js ingest --sources memory,session-logs,review
```

Tier 2 は明示的な `--tier2` と正の `--budget-files` が必須です。Tier 2 だけを処理する
夜間バッチでは `--sources` も明示してください。budget は各 Tier 2 reader が新しい順に
読むファイル数の上限です。

```text
node dist/cli.js ingest --sources claude-jsonl,codex-jsonl --tier2 --budget-files 500
```

`--sources` を省略したまま `--tier2` を付けると、Tier 1 と Tier 2 の両方が対象になります。
ingest は非同期で、CLI は run id を返します。完了確認は次の API で行います。

Memoria の diary API は月単位の一覧しか提供しないため、reader は 1970-01 から現在月までを
列挙して古い日記の後編集も検出します。本文の再読込・再蒸留は mtime と locator のカーソルを
超えた項目だけです。

```text
GET /api/clone/ingest/runs/<run-id>
```

## HTTP API

| Method | Path | 用途 |
|---|---|---|
| GET | `/healthz` | DB カード数と Ollama/model の readiness |
| POST | `/api/clone/query` | ローカル embedding と sqlite-vec でカード検索 |
| POST | `/api/clone/query-batch` | 複数クエリの embedding を 1 回の Ollama 往復に集約 (上限 50 件、p95 改善策) |
| GET | `/api/clone/cards` | `domain`、`visibility`、`tag`、`q`、pagination 付き一覧 |
| GET | `/api/clone/cards/:id` | カード取得 |
| POST | `/api/clone/cards` | 手動カード追加 |
| PATCH | `/api/clone/cards/:id` | 本文・象限・supersede 更新。必要時は再 embedding |
| POST | `/api/clone/ingest/run` | 非同期 ingest 開始 |
| GET | `/api/clone/ingest/runs/:id` | ingest 状態取得 |
| GET | `/api/clone/stats` | 象限・tier・supersede・最終 ingest 集計 |
| GET | `/api/clone/export?visibility=public` | active public カード export |

DELETE API はありません。履歴は `supersededBy` で保持します。詳細な body と response は
`spec/interface/api.md` を参照してください。

## MCP server

stdio MCP server は public 専用 tool `genius_query` を提供します。Genius サービスを先に起動し、
クライアント設定では repository を cwd にして compiled server を指定します。

```json
{
  "command": "node",
  "args": ["<repo>/dist/mcp/server.js"],
  "cwd": "<repo>"
}
```

開発時の手動確認には `npm run mcp` も利用できます。stdio の stdout は MCP データ専用で、
診断は stderr に出力されます。

## Harness hook

`hooks/genius-supply.mjs` は UTF-8 prompt を stdin で受け、カード配列を
`[genius-supply]` ブロックとして stdout に返します。config loader の compiled module を
利用するため、先に `npm run build` が必要です。検索は public 固定で、内部メタデータは
stdout へ出しません。手動確認・テスト用の契約は厳格 (fail-closed) です。

```powershell
'実装方針をどう決めるべきか' | node hooks/genius-supply.mjs
```

失敗時は stdout に空ブロックを返さず、stderr と非 0 exit で明示的に失敗します。

### Claude Code UserPromptSubmit への配線

`hooks/genius-supply.mjs` を UserPromptSubmit hook に直接指定しないでください。
Claude Code は raw prompt 文字列ではなく JSON payload (`{ prompt, cwd, session_id,
... }`) を stdin へ渡すため、そのまま配線すると payload 全体が query 文字列に
なってしまいます。加えて、fail-closed 契約はセッション全体のプロンプト送信を
Genius 未起動時にブロックしてしまうため、常時起動していない補助サービスとして
不適切です。

`hooks/genius-harness-supply.mjs` はこの2点を解消する配線用アダプタです。
JSON payload から `prompt` を取り出し、`GENIUS_HARNESS_HOOKS=1` の opt-in のときだけ
動作し、タイムアウト (既定 2000ms、`GENIUS_HARNESS_TIMEOUT_MS` で変更可) を含む
あらゆる失敗を fail-open (無音の exit 0) として扱います。Genius が未起動・低速でも
プロンプト送信を妨げません。カード取得・整形ロジックは `genius-supply.mjs` と共有します。

| 環境変数 | 用途 |
|---|---|
| `GENIUS_HARNESS_HOOKS` | `1` で有効化。未設定/他の値は no-op (既定 disabled) |
| `GENIUS_HARNESS_TIMEOUT_MS` | クエリのタイムアウト予算 (既定 2000) |
| `GENIUS_HARNESS_DEBUG` | `1` で診断ログを stderr へ (カード内容は出力しない) |

`E:/Document/Ars/.claude/settings.json` の `UserPromptSubmit` へ実際に配線するのは
Ars 側の運用作業です (この repository はスクリプト提供まで)。配線する場合は
他の supply hook (`anatomia-supply.mjs` 等) と同様に、次の形の entry を追加します。

```json
{
  "type": "command",
  "command": "node Genius/hooks/genius-harness-supply.mjs",
  "timeout": 3
}
```

有効化するホスト環境では `GENIUS_HARNESS_HOOKS=1` を settings.json の `env` に
設定してください。

## 日次運用と Concordia Timer Delegation

日次ジョブは Genius サービスが Excubitor 管理下で稼働していることを確認してから、
repository を working directory として次を実行する想定です。

```text
node dist/cli.js ingest
```

Timer Delegation には上記 command、Genius repository の working directory、失敗時の通知を
設定します。CLI 成功は非同期 run の受付成功を表すため、返された run id を
`GET /api/clone/ingest/runs/:id` で polling し、`completed` を完了条件にしてください。

### Tier 2 夜間バッチ (Memoria #550)

Tier 2 は日次 Tier 1 と分け、明示 budget 付きの夜間 job にします。`--sources` を
省略したまま `--tier2` を付けると Tier 1 と Tier 2 の両方が対象になってしまうため、
夜間 job では Tier 2 ソースのみを明示します。

```text
npm run ingest:tier2-nightly
```

このスクリプトは `node dist/cli.js ingest --sources claude-jsonl,codex-jsonl --tier2
--budget-files 500` を固定でラップしたものです (`test/cli.test.ts` に、この厳密な引数列が
CLI パーサと ingest サービスの契約どおりに解決されることを保証する回帰テストがあります)。
budget を変える場合は `node dist/cli.js ingest --sources claude-jsonl,codex-jsonl --tier2
--budget-files <N>` を直接呼び出してください。

Timer Delegation の実際のスケジュール登録 (cron 式・delegation template の追加) は
Concordia 自身のコード (`src/delegation/seed.ts` の template 定義と
`src/scheduler/cron-jobs.ts` の `CRON_JOBS` 配列) を編集して行う、Concordia 側の実装です。
Concordia には他リポが自己登録できる設定ファイルや API は無く、既存の 2 件
(`ludiars-review-daily`、`daily-review-reconciliation`) もすべて Concordia 内の
固定リストとして追加されています。Genius リポジトリはこの `npm run
ingest:tier2-nightly` を Timer Delegation の呼び出し先として提供するところまでが
スコープで、Concordia 側への template・cron 追加はこの repository の実装スコープ外です。

Timer 登録そのものと Excubitor 起動設定はこの repository の実装スコープ外です。

## Recall 評価

`eval/gold.jsonl` に 1 行 1 JSON で既知ペアを置きます。これは実データを含むため
gitignore 対象です。

```json
{"query":"設定不備をどう扱うか","expectedSourceRefs":["memory:decision#fail-fast"]}
```

サービス起動後に次を実行します。

```text
npm run eval
```

gold が未作成なら、その旨を表示して exit 0 になります。既存ファイルが不正、または API
query が失敗した場合は fail-fast します。

## Re-embedding

モデル移行は全カードを再 embedding し、成功後に active model を切り替えます。

1. 1024 次元を返すローカル model を Ollama へ pull する。
2. SQLite backup を取得する。
3. Excubitor または人間が Genius サービスを停止する。
4. `node dist/cli.js reembed --model <new-local-model>` を実行する。
5. サービスを再起動し、`/healthz` と代表 query を確認する。

途中で失敗した場合は旧 index と active model を維持し、無言で旧 model へ
フォールバックしません。

## Backup / restore

`clone_cards` が正本で、vector と embedding cache は再生成可能です。ただし通常は
cursor と run 履歴を含む SQLite 全体を backup します。

- 稼働中の DB はファイル 1 個だけを直接コピーせず、SQLite CLI の `.backup` API を使います。
- backup は `data/backups/` など gitignore 配下へ日時付きで保存し、別媒体へ移送します。
- `genius.config.json` は個人パスを含むため、repository 外のアクセス制御された場所へ
  別途 backup します。
- raw copy/restore を行う場合は、Excubitor または人間がサービスを停止してから DB、WAL、SHM
  を一組として扱います。restore 後は migration、`/healthz`、代表 query を確認します。

例として、SQLite CLI がある環境では次の形で一貫した snapshot を取得できます。実行前に
保存先ディレクトリを作り、ファイル名を日時付きに変更してください。

```text
sqlite3 data/genius.db ".backup 'data/backups/genius-snapshot.db'"
```

## トラブルシューティング

| 症状 | 確認事項 |
|---|---|
| config が無いという起動エラー | `genius.config.example.json` を `genius.config.json` へコピーし、example を直接使用しない |
| `/healthz` が 503 / Ollama unavailable | Ollama の稼働、`ollama list`、embedding model 名を確認する |
| model not pulled | `ollama pull <model>` 後に再実行する。別 backend へ自動切替しない |
| Ollama GPU runner が明示エラーになる | GPU runtime を修復するか、意図して CPU 実行する場合だけ config の `embedding.numGpu` または `GENIUS_EMBEDDING_NUM_GPU=0` を設定する |
| 疎なリクエスト後に最初のクエリだけ極端に遅い/詰まる | GPU runtime が壊れたホストでは unload 後の再ロードが GPU 経路を試みて失敗し得る。`embedding.keepAlive` または `GENIUS_EMBEDDING_KEEP_ALIVE` (例 `"30m"`) でモデル常駐を維持する |
| source is not configured | config の該当 source を設定する。意図した欠損だけ `--allow-missing` を使う |
| Tier 2 budget error | `--tier2 --budget-files N` を組にして指定する |
| Claude CLI 起動・認証エラー | `claude` が PATH 上にあり、対話不要で認証済みか確認する |
| MCP/hook が config を見つけない | cwd を repository にするか、loopback の `GENIUS_BASE_URL` を明示する |
| hook が compiled config を見つけない | repository で `npm run build` を実行する |
| active model / dimension mismatch | config と 1024 次元 index を確認し、必要なら maintenance 手順で reembed する |
| ingest が受付後に失敗する | run status と `logs/ingest.jsonl` を確認する。エラーを無視して cursor を進めない |

## Excubitor catalog

`genius.config.example.json` と設計書では 4230 を候補値として使用していますが、catalog 登録は
運用側の作業です。サービス port と endpoint の正本は登録後の Excubitor catalog / ProcessMap
であり、登録値と `genius.config.json` を一致させてください。実装セッションや worktree から
サービスを直接 spawn しません。

## ドキュメント

| 場所 | 内容 |
|---|---|
| `spec/feature/clone-db.md` | 本体設計 (アーキテクチャ・パイプライン・四象限) |
| `spec/data/schema.md` | DB スキーマ |
| `spec/interface/api.md` | API / 設定ファイル |
| `spec/setup/setup.md` | セットアップ |
| `spec/test/test.md` | テスト戦略と recall 評価 |
| `spec/plan/2026-07-17-feasibility.md` | 実現可能性定義 |
| `spec/tasks/` | 実装タスク分解 (正本) |
