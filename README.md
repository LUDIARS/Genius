# Genius — 自分クローン判断カード DB

「作業用に高速参照される自分自身のクローン情報」データベース。
過去の LLM 作業データ (Claude/Codex transcripts・session-logs・レビュー成果物・
Concordia アーカイブ・memory) から「何かを実装する時、私ならどう思うか」を
**判断カード** (場面 / 判断 / 理由) に蒸留し、ローカル埋め込みでベクタライズして、
Claude / Codex が実装着手時に **FT 的な思考判断を高速再現**できるようにする。

- 名前の由来: ローマ神話の *genius* — その人自身に宿る守護霊。
- 方式: retrieval-conditioned judgment (擬似 FT)。真の fine-tuning ではなく
  判断カード top-k のプロンプト注入で人格を再現する。
- 四象限: `domain: work|hobby` × `visibility: public|sensitive`。
  センシティブ象限は**外部 embedding API に送らない** (全象限ローカル埋め込みで統一)。

## スタック

TypeScript / Hono / better-sqlite3 + **sqlite-vec** / Ollama (bge-m3, 1024 dim)。
ポート **4230** (Excubitor catalog 正本)。DB は `data/genius.db` (gitignore)。

## ドキュメント

| 場所 | 内容 |
|---|---|
| `spec/feature/clone-db.md` | 本体設計 (アーキテクチャ・パイプライン・四象限) |
| `spec/data/schema.md` | DB スキーマ |
| `spec/interface/api.md` | API / 設定ファイル |
| `spec/setup/setup.md` | セットアップ (Ollama / 設定) |
| `spec/test/test.md` | テスト戦略 (ゴールド標準 recall 評価) |
| `spec/plan/2026-07-17-feasibility.md` | 実現可能性定義 (経緯) |
| `spec/tasks/` | 実装タスク分解 (正本) |
