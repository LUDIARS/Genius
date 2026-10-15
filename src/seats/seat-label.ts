import {
  JUDGMENT_SEAT_QUESTIONS,
  JUDGMENT_SEATS,
  judgmentSeatSchema,
  NO_SEAT_LABEL,
  type JudgmentSeat,
} from "../domain/seat.js";
import { contract } from '../contract-runtime.js'; /* augur-inject:import:3b6e135a */
import augurContract_8a67a72e from '../contracts/seat-label.contract.js'; /* augur-inject:contract-predicate:02fd1363 */

/** 判定バックエンドへ渡すラベル一覧 (9 席 + 「どれにも当たらない」)。 */
export function seatClassifierLabels(): Readonly<Record<string, string>> {
  return {
    ...Object.fromEntries(JUDGMENT_SEATS.map((seat) => [seat, JUDGMENT_SEAT_QUESTIONS[seat]])),
    [NO_SEAT_LABEL]: "どの席の判断にも当たらない (個人の趣味・雑談・作業手順の記録など)",
  };
}

/**
 * 判定バックエンドが返したラベル → 提案する席 (spec/feature/judgment-outcome.md §4.2)。
 * `none` は null (席なしの提案)。語彙外は読み替えずに投げる — 近い席へ丸めると
 * 人間の確定画面に根拠の無い提案が並ぶ。
 *
 * @implements SPEC-GENIUS-SEAT-TAG
 */
export function toProposedSeat(label: string): JudgmentSeat | null {
  if (label === NO_SEAT_LABEL) return null;
  const parsed = judgmentSeatSchema.safeParse(label);
  if (!parsed.success) throw new Error(`Seat classifier returned a label outside the vocabulary`);
  return parsed.data;
}
// @ts-expect-error augur-inject
toProposedSeat = contract(toProposedSeat, { ...augurContract_8a67a72e, contractId: 'C-5', mode: 'observe', sample: 1, where: 'src/seats/seat-label.ts:24', rule: 'contract-wrap', id: '8a67a72e' }); /* augur-inject:contract-wrap:8a67a72e */
