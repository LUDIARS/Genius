# Genius — プロジェクトルール

- 概要は `README.md`、設計正本は `spec/feature/clone-db.md`。
- LUDIARS 共通規約に従う: SRP・1 ファイル 1 責務・main 直 push 禁止
  (feat ブランチ + PR)・エラー握りつぶし禁止・無言フォールバック禁止。
- ポートは **4230** 固定 (正本: Excubitor catalog)。ハードコードせず
  `genius.config.json` loader 経由で解決する。
- **実データをコミットしない**: `data/` (DB・蒸留結果)・`genius.config.json`
  (個人パスを含むローカル設定) は gitignore 対象。テストは合成フィクスチャのみ。
- センシティブ象限のテキストを外部 embedding API へ送るコードを書かない。
  埋め込みは常にローカル (Ollama)。
- 蒸留 LLM backend は設定で切替可能 (`claude-cli` 既定 / `ollama` ローカル)。
  設定不備時は fail-fast (stub や no-op への無言フォールバック禁止)。
