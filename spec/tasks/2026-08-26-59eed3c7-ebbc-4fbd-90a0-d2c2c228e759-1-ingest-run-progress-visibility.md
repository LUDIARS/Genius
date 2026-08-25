---
task: "ingest-run-progress-visibility"
project: "genius-ingest-daily"
kind: "実装"
created: "2026-08-26"
---
# Genius ingest run の進捗可視化 (filesProcessed が running 中 0 のまま)

## 目的

Tier 1 ingest run の停滞調査を行った結果、run 自体は文書単位で着実に進行しており、
停滞していなかったことを確認した。誤って停滞と判断された原因は
`GET /api/clone/ingest/runs/:id` が `IngestRunStore.create()` の初期値 (0) を
`finish()`/`fail()` (run 完了時) まで更新しない実装ギャップであり、running 中の
run は常に `filesProcessed: 0` を返し続けていた。外形監視 (日次 ingest
delegation の polling) からはログを tail しない限り「停滞」と「正常進行中」を
区別できない状態だったため、この実装ギャップを解消する。

## 完了条件

- [x] `IngestRunStore` に `progress(id, totals)` を追加し、`IngestService`
  が文書 1 件の蒸留成功ごとに `distill_runs` へ累積進捗を反映する。
- [x] `spec/feature/operations.md` に §11 として原因と対処を追記した。
- [x] 回帰テスト (`test/ingest/ingest-service.test.ts` — running 中に
  `runs.get()` が更新済みの `filesProcessed` を返すことを検証) を追加した。
- [x] `npm run typecheck` / `npm test` が worktree で通ることを確認した。

## スコープ (編集可ディレクトリ)

- `src/ingest/`
- `test/ingest/`
- `spec/feature/operations.md`
- `spec/tasks/`

## 補足

- 停滞と誤判断された run 自体は正常に進行しており、本タスクでは run の
  強制終了・retry-failed は行っていない (対象外)。
- `unresolvedFailures` が起動直後から出ていた点は、DB 全体の未解決失敗
  (`distillation-output-invalid` / category enum 違反) のスナップショットであり、
  この run 自体が起こした異常ではない。category enum 違反は別課題 (直近コミット
  「蒸留リトライで無効な category 値を指摘し修正を促す」) の対象で、本タスクの
  スコープ外。
