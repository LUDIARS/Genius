# task-02 埋め込みクライアント + ベクトル索引層

kind: feature
status: todo

## 内容

- `EmbeddingClient`: Ollama `/api/embed` (bge-m3, 1024 dim)。参考:
  Anatomia `src/providers/openai-embedder.ts` (OpenAI 互換版)。
  content-addressed キャッシュ (テキスト sha256 → vector、DB 内 or file)。
- vec 索引層: カード upsert 時に埋め込み → clone_vec へ。検索は
  「vec0 KNN k×4 → clone_cards JOIN で domain/visibility/superseded 除外 →
  上位 k」 (`spec/data/schema.md`)。
- `genius reembed --model <name>`: 全カード再埋め込み + embedding_meta 切替。
- Ollama 未達 / モデル未 pull は明示エラー (無言フォールバック禁止)。

## Done 条件

- sqlite-vec 実体の KNN 統合テスト green (固定ベクトルで期待順)
- `GENIUS_TEST_OLLAMA=1 npm test` で bge-m3 実経路テスト green (このマシンは pull 済)
- `grep -ri "text-embedding\|api.openai" src/` → 0 件
