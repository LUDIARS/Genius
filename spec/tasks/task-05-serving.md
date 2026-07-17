# task-05 提供面 (API / CLI / MCP / フックスクリプト)

kind: feature
status: done (2026-07-17 — p95 は CPU フォールバック環境の waiver つき。spec/feature/clone-db.md §6 参照)

## 内容

- `spec/interface/api.md` の全エンドポイント (DELETE なし・127.0.0.1 bind)。
- CLI: `genius query / ingest / stats / reembed`。
- MCP server (stdio): tool `genius_query`。
- `hooks/genius-supply.mjs`: stdin → top-k カードを `[genius-supply]`
  ブロックで stdout (Ars 側への配線は運用スコープ外)。
- PATCH での象限訂正・本文修正時は再埋め込み。

## Done 条件

- query e2e テスト green (象限フィルタ / supersede 除外 / k 制限)
- `/api/clone/query` の応答に tookMs が入り、フィクスチャ 1k カードで
  p95 < 300ms (ローカル計測値を PR に記載)
- MCP tool が stdio で list/call に応答する smoke テスト
