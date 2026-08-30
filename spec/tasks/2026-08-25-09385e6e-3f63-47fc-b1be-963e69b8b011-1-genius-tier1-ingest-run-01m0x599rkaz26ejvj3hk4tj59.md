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

## 追記 (2026-08-29): 同種の停滞が別 run で再発

- 日次 Tier1 ingest 委託 (genius-ingest-daily, run_id
  b2d70a09-9496-4464-ab5e-2b745063ac6c) で起動した run
  `01M14WFN0WCDF02PVWW60FX3NW` が、開始直後から `status: running`
  `filesProcessed: 0` のまま17分以上無進捗で停滞。Excubitor の
  `genius` サービスログには本 run のドキュメント処理ログが一件も
  出力されておらず (直近ログは約21時間前の別 run 分)、LLM 呼び出しログ
  (`excubitor_llm_logs`) も空。claude-cli 呼び出しが応答なく停止する
  既知現象と一致する。
- `--retry-failed` を試みたが、当の run 自身が `memory` ソースを
  「アクティブ」として保持したままのため `Ingest source already has
  an active run: memory` (HTTP400) で拒否された。停滞した run が
  自己解消せず reject 応答も返さないまま残存するケースがあることを
  示す。
- プロセスの kill・サービス再起動は担当外のため未実施。前回調査
  (2026-08-28) の「サービス再起動で category invalid_value は解消
  しない」という結論と合わせ、根本原因はサービス再起動では解消
  しない、claude-cli 呼び出し自体の恒久的な停止対策 (タイムアウト・
  ヘルスチェック・自動リトライ機構) が必要と考えられる。修正は
  引き続き別タスクへ持ち越す。

## 追記 (2026-08-31): `filesProcessed=0` 停滞の実態は表示バグ、category invalid_value はプロンプト修正後も一部再発

日次 Tier1 ingest 委託 (genius-ingest-daily, run_id
14caec42-1b1b-415a-a741-26d0523dfca2) で起動した run
`01M1A19J7BJVJPQV791SQ6TR42` で、本 task が扱う2つの既知現象を
それぞれ実地で切り分けられた。

1. **`filesProcessed=0` 表示停滞は「表示バグの再発」であり実処理停滞ではなかった**。
   run 開始直後から `GET /api/clone/ingest/runs/:id` が `filesProcessed:0` を
   返し続けたが、`logs/ingest.jsonl` を tail すると文書単位の
   `document-started`/`document-completed` が実際には 1〜4分ペースで
   継続的に進行していた。`dist/ingest/ingest-service.js` の mtime を
   確認したところ `Aug 25 15:31` のままで、`grep SPEC-GENIUS-INGEST-RUN-PROGRESS
   src/ingest/ingest-service.ts` はヒットするが `dist/` 側には無く、
   progress fix (commit 3313e33/4152037, PR #1130) が稼働プロセスへ
   未反映のままだった。[[project-genius-retry-failed-service-hang]] の
   2026-08-29〜30 追記と同一原因の再発であり、**サービスの再ビルド漏れが
   解消しない限り毎回再現する**。次に `filesProcessed=0` 停滞に見えたら、
   まず `logs/ingest.jsonl` の tail で実処理が進んでいるかを確認すること
   (API値だけで「停滞」と判断しない)。
2. **`review` ソースの `category invalid_value` は PR #1106 のプロンプト
   修正 (2026-08-29マージ) 後も残存する**。本 run (169文書処理) で
   `distillation-output-invalid` により 14 件が失敗、すべて `review`
   ソース。`--retry-failed` を1回実行したところ 14 件中 7 件は成功したが
   残り 7 件 (`Tirocinium/2026-07-15/REVIEW_CODE_QUALITY.md`,
   `Cernere/2026-07-15/REVIEW.md`, `Cernere/2026-07-15/REVIEW_DESIGN.md`,
   `Cernere/2026-07-15/REVIEW_VULNERABILITY.md`,
   `Lictor/2026-07-13/REVIEW_VULNERABILITY.md`,
   `Pictor/2026-07-13/REVIEW_VULNERABILITY.md`,
   `Augur/2026-07-13/REVIEW.md`) は同一エラーで再発した。つまり
   PR #1106 の「観測済み誤発明例を名指しする」プロンプト修正は発生率を
   下げたが根絶はしていない。**How to apply:** 次に同種の失敗が出たら、
   [[project_tier2-distillation-failing]] の 2026-08-29 追記にある
   診断手法 (claude CLI へ直接同一プロンプト+文書を投げ category
   フィールドのみ確認、DB/ログ非転記) で今回の 7 件が実際にどの
   語彙外値を発明したかを確認し、プロンプトへの追加名指しで足りるか、
   それとも制約付き生成 (JSON Schema 制約や enum 強制) が必要かを
   判断すること。

**本 task の完了条件について:** 「停滞原因調査」という目的に対しては、
上記2点で原因は十分に切り分けられた (表示バグ=再ビルド漏れ、
category invalid_value=プロンプト修正では不十分な残存率) と判断する。
本 task はコード修正・PR作成が禁止された調査タスクのため、実装対応
(dist再ビルドをExcubitor起動コマンドに組み込む、category制約強化) は
別タスクへ持ち越す。
