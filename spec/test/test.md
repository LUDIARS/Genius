# Genius テスト戦略

vitest。実データ・個人パスをテストに使わない (合成フィクスチャのみ)。

## 単体

- config loader: example のみ→起動エラー / null ソース指定→明示エラー /
  env override。
- リーダ各種: フィクスチャ MD / JSONL → ドキュメント抽出 (`test/fixtures/`)。
- 蒸留: `DistillLlm` を決定的 fake に差し替え、カード整形・象限付与・
  センシティブ二重チェック降格・統合 (superseded_by) を検証。
  ※ fake は蒸留ロジックの単体検証用。sqlite-vec / Ollama の実経路は下記統合で担保。

## 統合 (実体)

- **sqlite-vec 実体テスト**: vec0 作成 → 既知ベクトル insert → KNN が期待順で
  返る (embedding は固定値配列、Ollama 不要)。
- **Ollama 実経路テスト** (`GENIUS_TEST_OLLAMA=1` 時のみ実行、無ければ
  「skip した」と明示出力): bge-m3 で 2 文を埋め込み、類似文ペア >
  非類似ペアの cosine になること。
- query API e2e: フィクスチャカード投入 → `/api/clone/query` が象限フィルタ・
  supersede 除外・k 制限を守る。

## ゴールド標準 recall 評価 (品質ゲート、CI 外)

`eval/gold.jsonl` に「クエリ → 期待カード source_ref」既知ペアを 20〜30 組
置き、`npm run eval` で recall@8 を出力する。実データ依存のため CI では
回さない (ローカル手動)。ペア作成は運用側 (Claude セッション) が行う。
