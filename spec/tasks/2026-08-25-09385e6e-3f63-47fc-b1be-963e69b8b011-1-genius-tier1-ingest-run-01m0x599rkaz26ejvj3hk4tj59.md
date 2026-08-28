---
task: "genius-tier1-ingest-run-01m0x599rkaz26ejvj3hk4tj59"
project: "genius-ingest-daily"
kind: "実装"
created: "2026-08-25"
---
# Genius Tier1 ingest run 01M0X599RKAZ26EJVJ3HK4TJ59 の停滞原因調査

## 目的
status=running のまま filesProcessed=0 で長時間停滞。unresolvedFailures=26 が起動直後から出ている点も含め、claude-cli呼び出し停止など既知現象の再発の可能性。run自体は残存中のため、状態確認・強制終了要否・retry-failed 判断は人間または別セッションで実施が必要。

## 完了条件
- Genius Tier1 ingest run 01M0X599RKAZ26EJVJ3HK4TJ59 の停滞原因調査 が完了している。

## 調査結果 (2026-08-28)

- 対象 run は調査時点で既に `completed-with-errors` (filesProcessed=318,
  unresolvedFailures=13) として自然完走していた。長時間の `filesProcessed=0`
  停滞は自己解消したとみられる (一時的な claude-cli 呼び出し停止という
  既知現象と整合)。
- 未解決失敗 13 件のうち確認できた内訳は、`memoria` 2 件 (JSON構文エラー)、
  `review` 10 件 (すべて `category: invalid_value` の Zod エラー)。残る 1 件は
  この調査で取得した記録からは特定できなかった。
- `review` の category 不一致は、`card_categories` へ `issue-discovery` を
  追加したコミット (3156660, 2026-08-25) 後、`DistillationService` が
  起動時に一度だけ vocabulary を固定する設計 (仕様通り、
  `spec/feature/operations.md` 39-42行目) により、旧プロセスのまま
  ingest すると新カテゴリが reject されることが原因と推測し、
  Genius サービスを再起動のうえ `--retry-failed` を実行 (cc-test 経由で
  claim/release 済み)。
- しかし **再起動後も同じ `review` ソースで category invalid_value が
  再発** (11件中10件)。`/api/clone/categories` では最新カテゴリを確認
  済みのため DB反映自体は正しく、「サービス再起動で解消する」という
  仮説は誤りか、少なくとも唯一の原因ではない。非転記方針により LLM の
  生出力はエラー記録へ含めず、Zod エラーメッセージにも入力値を含めないため、
  実際に返された不正な category 値はこの調査の範囲では特定できなかった。
- 同じ失敗形は `spec/plan/problem_logs/2026-08-23-distill-retry-repeats-invalid-category.md`
  に記録済みで、訂正ヒントを再試行プロンプトへ加える修正 (97d0a7c,
  2026-08-23) も本 run より前に存在する。次の切り分けでは、再起動したサービスの
  配布済みビルドにこの修正が含まれるかを先に確認し、含まれる場合は訂正ヒント後も
  不正値が繰り返される理由を調べる必要がある。
- 本 task はコード修正・テスト実行・PR 作成を禁止された調査タスクの
  ため、原因の完全特定と修正は別タスクへ持ち越す。次回同種の調査で値の
  特定が必要なら、`requestValidatedJson`/`json-completion.ts` 側で生出力全体を
  保存せず、検証対象の category フィールドだけを長さ制限・制御文字除去したうえで
  機微情報として一時的かつローカルに採取し、調査後に破棄する診断手段が必要になる。
