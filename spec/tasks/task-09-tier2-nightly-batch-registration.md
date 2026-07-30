# task-09 Tier2 夜間バッチ登録 (Memoria #550)

kind: chore
status: done (Genius リポジトリ側スコープのみ)

## 内容

Tier 2 (Claude/Codex 生 JSONL、計 2.7GB) の夜間バッチ投入を「登録」する。
実際にバッチを起動するのではなく、スケジュール実行対象として安定して呼び出せる
コマンドを Genius リポジトリ側に用意することがスコープ。

- `package.json` に `ingest:tier2-nightly` スクリプトを追加。
  `node dist/cli.js ingest --sources claude-jsonl,codex-jsonl --tier2` を
  固定でラップする。budget は指定しない (未指定 = 上限なし = 全未読ファイル。
  `spec/feature/operations.md` §6 / 人間判断 #5「全部」)。
  当初は `--budget-files 500` を付けていたが、§6 の全量投入化で撤去した。
- `test/cli.test.ts` に、この厳密な引数列 (`--sources
  claude-jsonl,codex-jsonl --tier2`) が CLI パーサと
  `POST /api/clone/ingest/run` の body 契約どおりに解決されることを保証する
  回帰テストを追加 (npm script の中身が CLI 契約からドリフトしたら赤くなる)。
  明示 `--budget-files` が引き続き上限として転送されることも別テストで担保する。
- README「日次運用と Concordia Timer Delegation」に Tier 2 夜間バッチの節を追加し、
  `npm run ingest:tier2-nightly` の呼び出し例と、Concordia 側の実際の登録手順との
  境界を明記した。

## Concordia 側との境界 (対応する Concordia 変更は本タスクのスコープ外)

調査の結果、Concordia の Timer Delegation は他リポが自己登録できる設定ファイルや
API を持たない。実体は Concordia 自身のソース内の固定リスト
(`Concordia/src/delegation/seed.ts` の template 定義 + `Concordia/src/scheduler
/cron-jobs.ts` の `CRON_JOBS` 配列) であり、既存 2 件 (`ludiars-review-daily`、
`daily-review-reconciliation`) もすべてこの形で追加されている。

`spec/tasks/task-06-ops.md` および README は「Timer 登録そのものはこの repository
の実装スコープ外」と既に明記しており、本タスクはその境界を維持する。Concordia 側へ
Genius Tier 2 夜間 job の template + cron 登録を追加する作業は、Concordia リポジトリ
に対する別 PR (Genius リポジトリの実装スコープ外) として扱う。

## Done 条件

- `npx vitest run test/cli.test.ts` green (新規 tier2-nightly 回帰テストを含む)
- `npm run typecheck` / `npm test` green
- README に Tier 2 夜間バッチの呼び出しコマンドと Concordia 側登録の境界が明記されている
