# Ingest の運用

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

Tier 2 は明示的な `--tier2` が必須です。`--budget-files` は任意で、未指定なら上限なし
(全未読ファイルを処理) です。明示指定した場合のみ、各 Tier 2 reader が新しい順に読む
ファイル数の上限として機能します (後方互換)。Tier 2 だけを処理する夜間バッチでは
`--sources` も明示してください。

```text
node dist/cli.js ingest --sources claude-jsonl,codex-jsonl --tier2
```

処理量を抑えたい場合だけ上限を付けます:

```text
node dist/cli.js ingest --sources claude-jsonl,codex-jsonl --tier2 --budget-files 500
```

`--sources` を省略したまま `--tier2` を付けると、Tier 1 と Tier 2 の両方が対象になります。
ingest は非同期で、CLI は run id を返します。完了確認は次の API で行います。

```text
GET /api/clone/ingest/runs/<run-id>
```

Memoria の diary API は月単位の一覧しか提供しないため、reader は 1970-01 から現在月までを
列挙して古い日記の後編集も検出します。本文の再読込・再蒸留は mtime と locator のカーソルを
超えた項目だけです。

## Ingest 失敗の隔離と再処理

1 文書の処理失敗で run 全体は止まりません。失敗文書は `ingest_failures` テーブルへ
永続化され (本文は保存しない)、run は残りの文書を処理して
`completed-with-errors` で終わります。run 状況の `failedDocuments` と
`unresolvedFailures`、`/api/clone/stats` の `unresolvedIngestFailures` で
「失敗を抱えたまま運用が続いている」状態を確認できます。

増分カーソルは失敗文書を追い越して前進するため、失敗文書の再処理は通常の
ingest ではなく `--retry-failed` で行います。これは `ingest_failures` の未解決
エントリだけをカーソル無関係に読み直し、成功したら `resolved_at` を立てます。

```text
node dist/cli.js ingest --sources <failed-source> --retry-failed
```

Tier 2 ソースの retry には `--tier2` も必要です (`--budget-files` は併用不可)。

### ソース単位の失敗 (`source-failed`)

`listDocuments` の失敗のように文書を特定できない失敗も run 全体を止めません。
該当ソースだけを `logs/ingest.jsonl` の `source-failed` と通知へ出し、残りの
ソースを処理して `completed-with-errors` で終わります。文書 locator が無く
`--retry-failed` が descriptor を復元できないため `ingest_failures` には
記録しません。したがって再処理は **通常の run** です
(`node dist/cli.js ingest --sources <failed-source>`)。通知の retry 行も
ソース単位の失敗には `--retry-failed` を付けません。

### LLM 向け判断指針 (通知を受けたときのフォールバック)

自動リトライは実装していません。判断は通知を受けたセッションの LLM、実行は
上記コマンドです。

- **リトライ**: `error_kind` が一時的要因のとき — `source-read-failed`
  (ファイルロック・一時 I/O)、`embedding-failed` (Ollama 未起動/再起動直後)。
  依存サービスの稼働を確認してから `--retry-failed` を 1 回実行する。
  例外: Memoria の `tasks/...` は payload を list した reader インスタンスだけが
  保持する仕様のため (`Memoria task descriptor must be read by the reader instance
  that listed it`)、`--retry-failed` では解消しない。カーソルも既に追い越して
  いるので、該当タスクが更新されて再度 list に載るまで未解決のまま残る
  (retry を繰り返さず skip 扱いにする)。
- **skip (放置)**: 同じ文書が retry 後も `distillation-output-invalid` /
  `processing-failed` で落ち続けるとき。未解決のまま残しても以後の run は
  止まらない。件数は stats に出続けるため、放置する場合はその判断を
  チャット/レポートに明記する。
- **人間へエスカレーション**: 同一ソースで失敗が多発する (reader やソース側の
  構造変化が疑われる)、retry を 2 回試しても解消しない、または判断に迷う
  場合。3 回同じ修正を試さない (three-out)。

## Concordia 通知

run が `failed` / `completed-with-errors` で終わると、`genius.config.json` の
`notify.concordiaBaseUrl` へ通知を POST します。`null` は通知無効で、起動時に
その旨を 1 行出力します。設定済みで到達不能な場合は通知エラーを stderr と
`logs/ingest.jsonl` (`notify-failed`) に明示しますが、ingest 本体の結果は
覆しません。

- 通知経路は Concordia の chat 投稿 API `POST /v1/chat`
  (`channel: "報告"`, `author_label: "Genius"`)。実パスは Concordia 側の正本
  `src/api/register-chat.ts` (`app.route("/v1/chat", chatRouter(...))`) と
  `src/api/chat.ts` (`PostSchema`: `channel` / `text` max 2000 /
  `author_label` 必須) で確認済み (2026-07-30)。
- payload に載せるのは run id・ソース名・失敗件数・エラー種別/メッセージ要約・
  ソース相対の文書パスのみです。文書本文・カード本文・絶対パスは載せません
  (Concordia の channel-archives は Genius 自身の ingest ソースであり、通知
  内容は DB へ環流するため)。

## 日次運用と Concordia Timer Delegation

日次ジョブは Genius サービスが Excubitor 管理下で稼働していることを確認してから、
repository を working directory として次を実行する想定です。

```text
node dist/cli.js ingest
```

Timer Delegation には上記 command、Genius repository の working directory、失敗時の通知を
設定します。CLI 成功は非同期 run の受付成功を表すため、返された run id を
`GET /api/clone/ingest/runs/:id` で polling し、`completed` または
`completed-with-errors` を完了条件にしてください (「`completed` 以外は失敗」と
判定しない — `src/client/ingest-run-contract.ts` の `isIngestRunSuccessful` を使う)。
`completed-with-errors` の場合は「Ingest 失敗の隔離と再処理」の指針に従います。

### Tier 2 夜間バッチ

Tier 2 は日次 Tier 1 と分け、budget なし (全量) の夜間 job にします。`--sources` を
省略したまま `--tier2` を付けると Tier 1 と Tier 2 の両方が対象になってしまうため、
夜間 job では Tier 2 ソースのみを明示します。

```text
npm run ingest:tier2-nightly
```

このスクリプトは `node dist/cli.js ingest --sources claude-jsonl,codex-jsonl --tier2`
を固定でラップしたものです (`test/cli.test.ts` に、この厳密な引数列が CLI パーサと
ingest サービスの契約どおりに解決されることを保証する回帰テストがあります)。budget は
未指定 = 上限なしです。上限を付けたい場合は `node dist/cli.js ingest --sources
claude-jsonl,codex-jsonl --tier2 --budget-files <N>` を直接呼び出してください。

**初回のみ手動実行で全量を消化してから timer に乗せてください。** 未読 backlog 全体
(生ログ数 GB 規模) を初回 run が一度に処理するため、実行時間が大きく伸びます。増分
カーソルがあるので 2 回目以降は実質差分のみですが、timer 側の完了待ちタイムアウトは
初回実測に合わせて設定してください。

カーソルはソース単位で「そのソースの batch を全件処理し終えた後」に保存されます。
文書単位の失敗は隔離されて run は続行するため (`ingest_failures` に記録され
`completed-with-errors` で終わる)、カーソルは通常どおり進みます。一方 run が
プロセスごと中断された場合 (timer のタイムアウト打ち切り・クラッシュ) は、その
ソースの進捗が保存されず次回は最初からやり直しになります。timer の完了待ち
タイムアウトが初回 run より短いと毎回打ち切られて永久に進まないため、初回は必ず
手動で完走させてください。

既に `--budget-files N` 付きで運用していた環境から移行する場合、保存済みカーソルに
未消化の catch-up 範囲が残っていることがあります。この場合 batch を mtime 降順に
保つため、上限なしでも 1 回目で catch-up 範囲、2 回目で残りの backlog という順に
分かれます (取りこぼし・再処理は無し)。`documents` が空になる run まで繰り返せば
消化完了です。

Timer Delegation の実際のスケジュール登録 (cron 式・delegation template の追加) は
Concordia 自身のコード (`src/delegation/seed.ts` の template 定義と
`src/scheduler/cron-jobs.ts` の `CRON_JOBS` 配列) を編集して行う、Concordia 側の実装です。
Concordia には他リポが自己登録できる設定ファイルや API は無く、既存の 2 件
(`ludiars-review-daily`、`daily-review-reconciliation`) もすべて Concordia 内の
固定リストとして追加されています。Genius リポジトリはこの `npm run
ingest:tier2-nightly` を Timer Delegation の呼び出し先として提供するところまでが
スコープで、Concordia 側への template・cron 追加と Excubitor 起動設定はこの repository の
実装スコープ外です。
