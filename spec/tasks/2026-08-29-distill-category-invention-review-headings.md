---
task: "distill-category-invention-review-headings"
project: "genius-ingest-daily"
kind: "実装"
created: "2026-08-29"
---
# 蒸留プロンプトの category invalid_value 恒久対策 — review 見出しからの発明を明示的に禁止

## 目的

2026-08-23 の correction hint 修正後も `review` ソースの文書で
`category: invalid_value` が3回のリトライ全てで再発していた。一回限りの
再現診断 (`claude` CLI への直接呼び出し、対象文書は
`Review/Augur/2026-07-13/REVIEW.md`) で、生の `category` フィールドだけを
確認した結果、LLM が許可語彙に無い `cicd_supply_chain` / `test_coverage` を
snake_case で発明していることを確認した。これは `review` ドキュメントの
見出し (`REVIEW_VULNERABILITY.md` など) をカテゴリ名と誤認する挙動であり、
2026-08-23 時点で疑われていた原因が確定した。

correction hint は「許可リストの中から選べ」とは伝えるが、モデルの実際の
誤解 (見出しをカテゴリとして扱っている) には言及していなかったため、
訂正が効かなかった。

## 実装

- `prompts/distill.md` の Category セクションへ、見出し由来の発明を
  名指しで禁止する段落を追加。観測された実例 (`cicd_supply_chain`,
  `test_coverage`) を挙げ、該当しない場合は `general` へ倒すよう指示。
- `spec/plan/problem_logs/2026-08-29-distill-category-invented-from-review-headings.md`
  へ原因調査と対策を記録。

## 完了条件

- [x] 仕様/問題ログを更新した (`spec/plan/problem_logs/`)
- [x] `prompts/distill.md` を更新した
- [ ] 回帰テストを追加/更新した — プロンプト文言はテキストの自然文であり、
      LLM 応答の決定的な単体テストは組めない。次回同種の失敗が出た場合の
      再現手順を problem log に明記することで代替する。
- [x] 変更を commit した
- [x] Revisor local PR を提出した (PR #1106, headRef `fix/distill-category-invention`)
- [ ] 委託元へ completed を報告した

## 注記 (前提未確定)

- サービス再起動・実運用での再検証はこのセッションでは行っていない
  (ユーザ指示によりプロンプト強化のみ選択、テスト実行は明示指示があるまで
  行わない方針)。次回の日次 ingest で `review` ソースの category
  invalid_value が解消しているかを確認する必要がある。
- この修正はプロンプトの自然文改善であり、モデルが今後も同じ助言を
  遵守する保証はない。再発した場合は problem log に記載した通り、
  統制外値を無言で `general` へ強制しない fail-fast 方針を維持したまま、
  制約付き生成または観測可能な回復経路を検討する。
