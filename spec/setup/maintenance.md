# 保守 (Recall 評価 / Re-embedding / Backup / トラブルシューティング)

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
3. Excubitor または人間が Genius サービスを停止する。catalog は
   `autostart: true` / `restart_policy: on-failure` なので、プロセスを直接
   kill すると異常終了とみなされて再起動され得ます。停止は Excubitor 経由で
   行い、作業中サービスが上がっていないことを確認してください。
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
  を一組として扱います。停止は Excubitor 経由で行います (`restart_policy: on-failure`
  のため、プロセスを直接 kill すると再起動されて DB が再び開かれ得ます)。
  restore 後は migration、`/healthz`、代表 query を確認します。

例として、SQLite CLI がある環境では次の形で一貫した snapshot を取得できます。実行前に
保存先ディレクトリを作り、ファイル名を日時付きに変更してください。

```text
sqlite3 data/genius.db ".backup 'data/backups/genius-snapshot.db'"
```

## トラブルシューティング

| 症状 | 確認事項 |
|---|---|
| config が無いという起動エラー | `genius.config.example.json` を `genius.config.json` へコピーし、example を直接使用しない |
| `/readyz` が 503 / Ollama unavailable | Ollama の稼働、`ollama list`、embedding model 名を確認する。`/healthz` はプロセス生存のみを返す |
| `/readyz` の `buildStale` が `true` | `npm run build` を実行し、Excubitor または人間の運用手順でサービスを再起動する |
| model not pulled | `ollama pull <model>` 後に再実行する。別 backend へ自動切替しない |
| Ollama GPU runner が明示エラーになる | GPU runtime を修復するか、意図して CPU 実行する場合だけ config の `embedding.numGpu` または `GENIUS_EMBEDDING_NUM_GPU=0` を設定する |
| 疎なリクエスト後に最初のクエリだけ極端に遅い/詰まる | GPU runtime が壊れたホストでは unload 後の再ロードが GPU 経路を試みて失敗し得る。`embedding.keepAlive` または `GENIUS_EMBEDDING_KEEP_ALIVE` (例 `"30m"`) でモデル常駐を維持する |
| source is not configured | config の該当 source を設定する。意図した欠損だけ `--allow-missing` を使う |
| Tier 2 budget error | `--budget-files N` は `--tier2` と組で、正の整数だけを指定する。未指定は上限なしで正常 |
| Claude CLI 起動・認証エラー | `claude` が PATH 上にあり、対話不要で認証済みか確認する |
| MCP/hook が config を見つけない | cwd を repository にするか、loopback の `GENIUS_BASE_URL` を明示する |
| hook が compiled config を見つけない | repository で `npm run build` を実行する |
| active model / dimension mismatch | config と 1024 次元 index を確認し、必要なら maintenance 手順で reembed する |
| ingest が受付後に失敗する | run status と `logs/ingest.jsonl` を確認する。文書単位の失敗は `ingest_failures` に残り、`--retry-failed` で再処理する |
| `completed-with-errors` が続く | `/api/clone/stats` の `unresolvedIngestFailures` と `ingest_failures` を確認し、[Ingest の運用](ingest.md) の「LLM 向け判断指針」に従って retry / skip / エスカレーションを判断する |
| 失敗通知が届かない | `notify.concordiaBaseUrl` が null になっていないか、起動ログの `[notify]` 行と `logs/ingest.jsonl` の `notify-failed` を確認する |
