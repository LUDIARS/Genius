import type {
  JudgmentSeat,
  SeatDecision,
  SeatProposal,
  SeatProposalStatus,
} from "../domain/seat.js";
import { contract } from '../contract-runtime.js'; /* augur-inject:import:cd25383d */
import augurContract_2349b22e from '../contracts/seat-decision.contract.js'; /* augur-inject:contract-predicate:1e2d3111 */

/** 確定操作を適用した結果。`cardSeat` がカードに付く席 (null = 席を付けない)。 */
export type SeatDecisionPlan =
  | {
    ok: true;
    status: Exclude<SeatProposalStatus, "proposed">;
    decidedSeat: JudgmentSeat | null;
    cardSeat: JudgmentSeat | null;
  }
  | { ok: false; reason: string };

/**
 * 席の提案に人間の確定 / 却下を当てる規則 (spec/feature/judgment-outcome.md §4.3)。
 *
 * - 確定・却下できるのは `proposed` の提案だけ (二重確定で人の判断を上書きしない)。
 * - confirm で `seat` を渡せば提案と違う席で確定できる。省略時は提案どおり。
 *   `seat: null` は「どの席にも当たらない」を人間が認めたことになる。
 * - reject は席を付けない。カードは次回の提案対象にも戻らない (同じ提案を繰り返さない)。
 *
 * @implements SPEC-GENIUS-SEAT-TAG
 */
export function planSeatDecision(proposal: SeatProposal, decision: SeatDecision): SeatDecisionPlan {
  if (proposal.status !== "proposed") {
    return { ok: false, reason: `proposal for ${proposal.cardId} is already ${proposal.status}` };
  }
  if (decision.action === "reject") {
    return { ok: true, status: "rejected", decidedSeat: null, cardSeat: null };
  }
  const seat = decision.seat === undefined ? proposal.proposedSeat : decision.seat;
  return { ok: true, status: "confirmed", decidedSeat: seat, cardSeat: seat };
}
// @ts-expect-error augur-inject
planSeatDecision = contract(planSeatDecision, { ...augurContract_2349b22e, contractId: 'C-6', mode: 'observe', sample: 1, where: 'src/seats/seat-decision.ts:28', rule: 'contract-wrap', id: '2349b22e' }); /* augur-inject:contract-wrap:2349b22e */
