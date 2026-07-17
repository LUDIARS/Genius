# task-06 運用 (増分バッチ / stats / 評価ハーネス)

kind: feature
status: todo

## 内容

- `genius ingest` の増分実行が冪等 (同一ソース再実行でカード重複しない)。
- `/api/clone/stats`: 象限別 / tier 別 / 最終 ingest 時刻 / supersede 数。
- `GET /api/clone/export?visibility=public` (JSON。datahub push 自体は別途)。
- `npm run eval`: `eval/gold.jsonl` (無ければ「未作成」と明示して非 0 exit
  しない) を読み recall@8 を出力。
- README に日次運用 (Concordia Timer Delegation から `genius ingest` を叩く
  想定コマンド) を追記。timer 登録自体はスコープ外。

## Done 条件

- 冪等性テスト green (2 回 ingest → カード数不変)
- stats / export の e2e テスト green
- `npm run eval` が gold 無しでも明示メッセージで正常動作
