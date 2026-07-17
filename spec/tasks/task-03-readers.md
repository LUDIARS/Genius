# task-03 収集リーダ群 (Tier 1 + Tier 2)

kind: feature
status: todo

## 内容

`SourceReader` 抽象 (source 名 / listDocuments(cursor) / readDocument) と実装 7 種:

- Tier 1: memory MD (frontmatter パース) / session-logs MD /
  channel-archives MD / Review (latest.json + MD) / Memoria API
  (diary・notes・tasks を HTTP GET、読み取りのみ)
- Tier 2: Claude transcripts JSONL / Codex sessions JSONL —
  ストリーム読み (全量メモリ展開禁止。1.5GB 級 dir を同期全走査しない。
  ファイル列挙→ mtime 降順→ budget 件数のみ処理)
- `ingest_state` カーソルで増分。`--allow-missing` 時のみ欠損ソースをスキップ
  (警告出力必須)。
- **ソースへの書き込み禁止** (open は読み取りモードのみ)。

## Done 条件

- 各リーダのフィクスチャ単体テスト green (`test/fixtures/`)
- Tier 2 リーダが budget 指定を超えて読まないテスト
- `grep -rn "C:/Users\|C:\\\\Users" src/` → 0 件
