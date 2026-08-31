---
task: "ingest-reader-io-timeout"
project: "genius-ingest-daily"
kind: "実装"
created: "2026-09-01"
---
# Genius ingest reader I/O にタイムアウトを追加する

## 目的

2026-09-01 の Tier1 ingest run (`01M1CKP6D2EG2TPD2S0EPG0SNA`) が
`filesProcessed=0` のまま 6 分超無進行し、`logs/ingest.jsonl` / stderr
とも当該 run 分のログが 0 件だった (Memoria task 1692)。既知の
claude-cli backend 一時停止や category invalid_value とは異なる系統で、
後に `/healthz` (I/O 無しでイベントループの空き具合そのものを返す契約) まで
タイムアウトし始めた。調査により run の最初期
(`reader.listDocuments`/`readDocument`) に無時限 await が残っていたことは
確認できたが、未解決 Promise は event loop 自体を塞がないため、今回の
`/healthz` timeout と同一原因だったかは未確定である。また reader 呼び出しは
`run-started` / `source-started` の記録後なので、当該 run のログが 0 件だった
こともこの欠落だけでは説明できない。
claude-cli 完了・readiness、jsonl ロガー append、Memoria fetch は既に
タイムアウト付きだが、reader の list/read だけが無時限のままだった。

## 完了条件

- [x] 仕様を更新した (`spec/feature/operations.md` §13
      `SPEC-GENIUS-INGEST-READER-IO-TIMEOUT`)
- [x] 実装した (`src/ingest/ingest-service.ts` の `withReaderTimeout`
      で `listDocuments` 120秒 / `readDocument` 60秒の上限を追加、
      タイムアウトは既存の `SourceReaderError` 分類・隔離経路にそのまま乗せる)
- [x] 回帰テストを追加した (`test/ingest/ingest-failure-isolation.test.ts`
      に `vi.useFakeTimers()` を使った listDocuments/readDocument ハング
      の2ケース)
- [x] 問題ログを記録した
      (`spec/plan/problem_logs/2026-09-01-ingest-reader-io-no-timeout.md`)
- [x] 変更を commit した
- [ ] Revisor local PR を提出した

## 未確定事項

今回の run で実際にどの reader / どちらの呼び出しがハングしていたかは、
本文非転記の運用方針 (spec/feature/operations.md §4) のため事後特定できて
いない。本タスクは今回の根本原因の修正ではなく、調査で見つかった
「未解決 Promise が run の
進行を止める」欠落クラスを塞ぎ、event loop が応答可能な場合に次回同じ症状が
出たとき `errorKind: source-read-failed` のログから詰まった
`source`/呼び出し種別が分かるよう
観測性を上げるものである。
