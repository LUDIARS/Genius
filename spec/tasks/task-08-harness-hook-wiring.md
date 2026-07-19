# task-08 ハーネスフック配線アダプタ (Memoria #549)

kind: feature
status: done

## 内容

`hooks/genius-supply.mjs` は意図的に厳格 (raw prompt 文字列を stdin で受け、
失敗時は非 0 exit) な CLI/テスト契約であり、Claude Code の UserPromptSubmit hook
にそのまま指定すると次の理由で不適切:

1. UserPromptSubmit は raw prompt 文字列ではなく JSON payload
   (`{prompt,cwd,session_id,...}`) を stdin へ渡す。
2. fail-closed 契約は、Genius (常時起動が前提でないローカル補助サービス) が
   未起動のときにセッション全体のプロンプト送信をブロックしてしまう。

`hooks/genius-harness-supply.mjs` を新設し、次を満たす配線用アダプタとした:

- JSON payload から `prompt` を取り出す (Claude Code の実際の hook 契約に一致)。
- `GENIUS_HARNESS_HOOKS=1` の opt-in でのみ動作 (既定 disabled)。
- `GENIUS_HARNESS_TIMEOUT_MS` (既定 2000ms) で境界づけられ、あらゆる失敗
  (timeout・接続不可・非 public カード等) を fail-open (無音 exit 0) として扱う。
- カード取得・整形ロジックは `genius-supply.mjs` の
  `queryGeniusForHook`/`formatGeniusSupply` を再利用 (ロジック重複なし)。
- `GENIUS_HARNESS_DEBUG=1` のときのみ stderr に診断を出す (カード内容は含めない)。

Ars 側 `.claude/settings.json` の `UserPromptSubmit` 配列への実際の登録は運用側
作業のまま (本リポはスクリプト提供まで、`spec/feature/clone-db.md` の既定方針を
維持)。README「Harness hook」に配線手順 (settings.json へ追加する entry の例) を
追記した。

## Done 条件

- `npx vitest run test/hook-harness-adapter.test.ts` green
  (既定 disabled no-op / JSON payload 解決 / 非 public カード遮断 / timeout
  fail-open / malformed stdin fail-open を検証)
- 既存 `test/hook-supply.test.ts` (genius-supply.mjs 本体の fail-closed 契約) は
  無変更のまま green