import type { CloneCard } from "../domain/card.js";
import { contract } from '../contract-runtime.js'; /* augur-inject:import:753c3f15 */
import augurContract_251110cd from '../contracts/followup-message.contract.js'; /* augur-inject:contract-predicate:d9710927 */

/** 判断の抜粋の上限。Concordia の 2000 文字上限に対して説明行の余白を残す。 */
const MAX_JUDGMENT_EXCERPT = 600;

/**
 * 「結果は?」の投稿文 (spec/feature/judgment-outcome.md §3.2)。
 *
 * 載せるのはカード id と、public カードなら judgment の抜粋だけ。
 * situation / rationale / sourceRef / 絶対パスは載せない (補完質問と同じ非転記ルール)。
 * sensitive カードは judgment も載せず、WebUI で本文を確認してもらう —
 * genius チャンネルは環流しない面だが、カード本文そのものはこの経路の外に置く。
 *
 * @implements SPEC-GENIUS-OUTCOME-FOLLOWUP
 */
export function formatOutcomeFollowupText(card: CloneCard, delayDays: number): string {
  const judgmentLine = card.visibility === "public"
    ? `判断: ${excerpt(card.judgment)}`
    : "判断: (sensitive のため本文は WebUI で確認してください)";
  return [
    `[genius] 結果は? — 判断から ${delayDays} 日経ちました`,
    `カード: ${card.id}`,
    judgmentLine,
    "この投稿へ返信すると outcome として記録します。",
    "1 行目に「一致」か「不一致」、続けて実際の結果を書いてください。",
    "カードと違う判断を採った場合は「採用: …」の行を足してください。",
  ].join("\n");
}
// @ts-expect-error augur-inject
formatOutcomeFollowupText = contract(formatOutcomeFollowupText, { ...augurContract_251110cd, contractId: 'C-7', mode: 'observe', sample: 1, where: 'src/outcome/followup-message.ts:16', rule: 'contract-wrap', id: '251110cd' }); /* augur-inject:contract-wrap:251110cd */

function excerpt(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length <= MAX_JUDGMENT_EXCERPT
    ? flattened
    : `${flattened.slice(0, MAX_JUDGMENT_EXCERPT - 1)}…`;
}
