# クライアント接続 (CLI / MCP / Harness hook / 棚卸し WebUI)

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
ingest の運用は [Ingest の運用](ingest.md) を参照。

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

ワークスペース側の `.claude/settings.json` の `UserPromptSubmit` へ実際に配線するのは
運用作業です (この repository はスクリプト提供まで)。配線する場合は
他の supply hook と同様に、次の形の entry を追加します。

```json
{
  "type": "command",
  "command": "node Genius/hooks/genius-harness-supply.mjs",
  "timeout": 3
}
```

有効化するホスト環境では `GENIUS_HARNESS_HOOKS=1` を settings.json の `env` に
設定してください。

## 棚卸し WebUI (`/ui/`)

サービス起動後、`http://127.0.0.1:<port>/ui/` でカード棚卸し画面を開けます
(port は `genius.config.json`。ハードコードしない)。ビルド手順は不要で、
`ui/` の素の HTML/CSS/ES modules をそのまま配信します (`npm run build` の対象外)。

できること: 象限・カテゴリー・タグ・全文フィルタと作成日/confidence ソート、
supersede 済み / retire 済みの表示切替、カード詳細 (本文・sourceRef・supersede
チェーン)、本文/カテゴリー編集、象限変更、supersede (既存カードで置換 /
新規カードで置換 / 置換リンク解除)、retire (置換先なしの非活性化 / 復活)、
手動カード追加、カテゴリー追加。

注意点:

- Genius 自身に認証はありません。既定の `127.0.0.1` 以外へ bind する場合は、
  前段でアクセス制御し、ブラウザ側の origin を `server.allowedOrigins` に完全一致で
  列挙してください。
- sensitive→public 昇格はサーバ側で二重チェックが再実行され、拒否されると 409 に
  なります。UI は拒否理由をそのまま表示し、成功したようには見せません。
- UI からの更新は `changedBy: "ui"` として `clone_card_revisions` に記録されます
  (記録されるのは変更された列名のみ)。
- ブラウザ経由の防御 (CORS 非提供・更新系の `Content-Type: application/json` 必須・
  loopback または明示許可されていない `Origin` の拒否) は `spec/interface/api.md` を参照。
