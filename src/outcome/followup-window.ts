import { contract } from '../contract-runtime.js'; /* augur-inject:import:fd98dc4f */
import augurContract_cc17228e from '../contracts/followup-window.contract.js'; /* augur-inject:contract-predicate:2dd007d6 */
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface FollowupWindow {
  /** 判断日 (カードの created_at) がこれ以上 (含む)。 */
  decidedFrom: number;
  /** 判断日がこれ以下 (含む) — 判断から delay 日以上経ったカード。 */
  decidedTo: number;
}

/**
 * 「結果は?」を訊いてよいカードの判断日の範囲 (spec/feature/judgment-outcome.md §3.1)。
 *
 * - 判断から `delayDays` 日経ったカードから訊く (既定 14 日)。
 * - それより `windowDays` 日以上古いカードは訊かない。導入時に既存の全カードへ
 *   一斉に「結果は?」が飛ぶのを防ぐ (過去分は WebUI / API から手で記入する)。
 *
 * @implements SPEC-GENIUS-OUTCOME-FOLLOWUP
 */
export function followupDueWindow(now: number, delayDays: number, windowDays: number): FollowupWindow {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("now must be a non-negative integer");
  if (!Number.isInteger(delayDays) || delayDays < 1) throw new RangeError("delayDays must be >= 1");
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new RangeError("windowDays must be >= 1");
  const decidedTo = now - delayDays * DAY_MS;
  return { decidedFrom: decidedTo - windowDays * DAY_MS, decidedTo };
}
// @ts-expect-error augur-inject
followupDueWindow = contract(followupDueWindow, { ...augurContract_cc17228e, contractId: 'C-3', mode: 'observe', sample: 1, where: 'src/outcome/followup-window.ts:19', rule: 'contract-wrap', id: 'cc17228e' }); /* augur-inject:contract-wrap:cc17228e */
