# task-04 蒸留ワーカー

kind: feature
status: todo

## 内容

- `DistillLlm` 抽象: `claude-cli` backend (`claude -p --model <m>`、JSON 出力
  指示) / `ollama` backend。設定不備は fail-fast。
- 蒸留プロンプトは `prompts/distill.md` 外部ファイル (反事実性条件・
  四象限分類・氏名/email 等の個人特定情報をカードへ転記しない指示を含む。
  初版はプレースホルダで良い — 較正は運用側)。
- パイプライン: ドキュメント → 0..N カード (JSON) → バリデーション →
  public 判定カードはセンシティブ二重チェック (降格のみ、削除しない) →
  重複統合 (同象限 cosine > 0.90 → LLM 統合判定 → superseded_by) → 保存 + 埋め込み。
- `POST /api/clone/ingest/run` (非同期) + `genius ingest` CLI + distill_runs
  記録 + `logs/` JSONL 実行ログ。

## Done 条件

- fake DistillLlm での単体テスト green (整形 / 降格 / 統合 / バリデーション)
- 不正 JSON 応答 → リトライ 2 回 → 明示エラー (握りつぶし禁止) のテスト
- `grep -rn "catch {}\|catch (e) {}" src/` → 0 件
