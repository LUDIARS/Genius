# task-07 蒸留プロンプト較正 (Memoria #546)

kind: chore
status: done

## 内容

task-04 で「初版はプレースホルダで良い — 較正は運用側」と留保していた
`prompts/distill.md` の較正を実施 (`spec/plan/2026-07-17-feasibility.md`
リスク1「蒸留品質」および実装委託メモ「蒸留プロンプト設計と品質較正は Claude 側が
担当」に対応)。

- 出力フィールドごとの制約を明文化 (`domain`/`visibility` は zod schema と一致、
  `tags` は 1-6 件の kebab-case、`confidence` は数値)。
- 反事実性のある判断が無い場合は `{"cards": []}` を返す指示を追加 (従来は
  「捨てる」とだけ書かれ、出力形状が未規定だった)。
- 合成の few-shot 例を 2 件追加: (1) 判断カードとして抽出される例、(2) 単なる
  状態報告で抽出されない例。実データはコミットしない方針のため、合成データのみ。

## 較正機構

`test/distill/prompt-calibration.test.ts` が `prompts/distill.md` を実行時に
読み込み、次を保証する:

- ファイル内の few-shot JSON 例が `distilledCardSchema` (zod) をそのまま満たす
  (プロンプト編集がコード側の契約からドリフトしたら即座に赤くなる)。
- 空判定 (`{"cards": []}`)・raw JSON only・PII 禁止事項の文言が失われていない。
- プロンプト自体に実在の絶対パスが混入していない。

LLM を実際に呼び出す評価 (実データ recall@8 相当) はサービス起動と実データを
要するため本タスクのスコープ外 (`npm run eval` の recall 評価とは別軸)。

## Done 条件

- `npx vitest run test/distill/prompt-calibration.test.ts` green
- 既存 `test/distill/*` green (プロンプト変更が蒸留パイプラインの契約を壊していない)