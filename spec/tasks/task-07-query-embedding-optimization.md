# task-07 クエリ埋め込み p95 改善 (GPU or 軽量モデル)

kind: feature
status: done (2026-07-19 — GPU / 軽量モデルは環境要因で見送り。バッチング +
keep_alive のソフトウェア最適化のみ実施。単一クエリ p95 waiver は継続。
Memoria タスク #553 対応。spec/feature/clone-db.md セクション 6 参照)

## 背景

spec/feature/clone-db.md セクション 6 の waiver (2026-07-17): 本機 (GTX 1070)
は Ollama の CUDA PTX 非対応で CPU フォールバックとなり実測 p95 = 555ms。
改善は「GPU runner 更新 or 軽量埋め込みモデル検討」で追う、とされていた。

## 調査結果

- GPU: この環境の CUDA PTX 非対応は環境要因で恒久対応不可。加えて、
  `numGpu` を明示しない状態でモデルが unload された後の次リクエストは
  GPU 経路をまず試みて失敗し、実測で単発 12.8 秒の詰まりを確認した
  (壊れた CUDA + Ollama 既定の 5 分アンロードの組み合わせ)。
- 軽量モデル: 1024 次元固定の `clone_vec` スキーマ (`VectorStore` が
  1024 以外の次元を拒否) を壊さずに使える同次元・軽量な埋め込みモデルの
  代替が見当たらなかった。次元を変える案はベクトル索引スキーマの移行が
  必要でこのタスクの範囲を超えるため、今回は見送り、将来課題として記録。
- CPU thread/ctx チューニング (`num_thread` / `num_ctx`) は実測で有意な
  改善が確認できず (ノイズが支配的)、config surface を増やさなかった。

## 実施した最適化

1. **keep_alive 設定** — `OllamaEmbeddingClient` に `keepAlive` オプション
   (Ollama `keep_alive`) を追加。`numGpu=0` と併用し、モデルが疎な実運用
   トラフィックでアンロードされて次回リクエストが壊れた GPU 経路を踏む
   事態を避ける。config (`embedding.keepAlive` / `GENIUS_EMBEDDING_KEEP_ALIVE`)
   から設定可能、既定は null (Ollama 既定動作を維持)。
2. **クエリバッチング** — `QueryService.queryMany` を追加し、複数クエリの
   埋め込みを 1 回の Ollama 往復に集約 (`embed(texts[])` は元々複数入力を
   受けられた)。`POST /api/clone/query-batch` (上限 50 件) と
   `GeniusHttpClient.queryMany` で配線し、`evaluateRecallAtK` (recall eval)
   を N 回の逐次 `.query()` から 1 回の `.queryMany()` に置き換えた。
   単一クエリの `/api/clone/query` 経路は意図的に変更していない
   (人為的なバッチ待ち遅延を注入しないため)。

## 実測 (この環境、2026-07-19)

- 単一クエリ p95 (既存ベンチ `test/performance/query-performance.test.ts`,
  1000 カード, samples=20): 756ms → 698-861ms (複数回計測、ノイズレンジ内で
  有意な変化なし。想定どおり — 変更していない経路のため)。
- バッチ化 (8 件): 逐次 730-754ms/query → batched 201-225ms/query
  (約 3.3〜4 倍/query の改善、3 回の実測で再現)。

## Done 条件

- typecheck / 既存テスト (`npm run typecheck`, `npm test`) green
- `GENIUS_TEST_OLLAMA=1 npm test` で keep_alive 実配線・batching 実速度
  テストが green (`test/embedding-client.test.ts`,
  `test/performance/query-performance.test.ts`)
- `POST /api/clone/query-batch` の e2e テスト green (1 回の embed 呼び出しに
  集約されることをモックで確認)
- 単一クエリ p95 waiver (spec/feature/clone-db.md セクション 6) は環境要因の
  まま継続。数値目標を無理に達成しない (今回のタスクの前提どおり)