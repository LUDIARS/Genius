import { z } from "zod";
import { decisionAuthorSchema, MAX_CARD_TEXT_LENGTH } from "./card.js";
import { contract } from '../contract-runtime.js'; /* augur-inject:import:a861da93 */
import augurContract_7d71ac2f from '../contracts/card-outcome.contract.js'; /* augur-inject:contract-predicate:12602ba6 */

/**
 * 判断カードの outcome — 「その判断を採って、実際どうなったか」
 * (spec/feature/judgment-outcome.md §2)。
 *
 * card-feedback (spec/feature/card-feedback.md) とは別物:
 * - feedback = カードを**検索で引いて使った側**が、ガイドとして効いたかを何度でも返す
 *   (検索品質・カード品質の信号。悪ければ自動アーカイブ)。
 * - outcome = **判断者本人**が、判断の結果が予想と一致したかを 1 枚に 1 つ記録する
 *   (判断の的中率の信号。アーカイブには使わない)。
 */
export const OUTCOME_VERDICTS = ["match", "mismatch"] as const;

export const outcomeVerdictSchema = z.enum(OUTCOME_VERDICTS);

export type OutcomeVerdict = z.infer<typeof outcomeVerdictSchema>;

/** outcome を書き込んだ経路。統制語彙 (migration 011 の CHECK と対)。 */
export const OUTCOME_RECORDED_VIA = ["api", "ui", "cli", "discord"] as const;

export const outcomeRecordedViaSchema = z.enum(OUTCOME_RECORDED_VIA);

export type OutcomeRecordedVia = z.infer<typeof outcomeRecordedViaSchema>;

// 採用した判断はカードの judgment をそのまま写すことがあるので、カード本文と同じ上限。
export const MAX_OUTCOME_TEXT_LENGTH = MAX_CARD_TEXT_LENGTH;

export const outcomeTextSchema = z.string().trim().min(1).max(MAX_OUTCOME_TEXT_LENGTH);

/** 1 枚のカードの outcome。既存カードは null (= 未記入)。 */
export interface CardOutcome {
  cardId: string;
  /** 実際に採用した判断 (カードの judgment と違うこともある)。 */
  adoptedDecision: string;
  /** 実際の結果。 */
  actualResult: string;
  /** 判断 (予想) と結果が一致したか。 */
  verdict: OutcomeVerdict;
  /** 記入者 (Discord user id 等)。 */
  recordedBy: string;
  recordedVia: OutcomeRecordedVia;
  /** 記入日時 (epoch ms)。サーバ時計で付ける。 */
  recordedAt: number;
}

export const recordOutcomeInputSchema = z.object({
  adoptedDecision: outcomeTextSchema,
  actualResult: outcomeTextSchema,
  verdict: outcomeVerdictSchema,
  recordedBy: decisionAuthorSchema,
}).strict();

export type RecordOutcomeInput = z.infer<typeof recordOutcomeInputSchema>;

export interface CardOutcomeRow {
  card_id: string;
  adopted_decision: string;
  actual_result: string;
  verdict: string;
  recorded_by: string;
  recorded_via: string;
  recorded_at: number;
}

/**
 * DB 行 → outcome。行が無い (= 既存カード・未記入) は null を返す。
 * 統制語彙外の値は読み替えずに投げる (DB の CHECK を迂回した値を黙って通さない)。
 */
export function toCardOutcome(row: CardOutcomeRow | undefined): CardOutcome | null {
  if (row === undefined) return null;
  return {
    cardId: row.card_id,
    adoptedDecision: row.adopted_decision,
    actualResult: row.actual_result,
    verdict: outcomeVerdictSchema.parse(row.verdict),
    recordedBy: row.recorded_by,
    recordedVia: outcomeRecordedViaSchema.parse(row.recorded_via),
    recordedAt: row.recorded_at,
  };
}
// @ts-expect-error augur-inject
toCardOutcome = contract(toCardOutcome, { ...augurContract_7d71ac2f, contractId: 'C-1', mode: 'observe', sample: 1, where: 'src/domain/outcome.ts:71', rule: 'contract-wrap', id: '7d71ac2f' }); /* augur-inject:contract-wrap:7d71ac2f */
