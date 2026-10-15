import { judgmentSeatSchema, type JudgmentSeat } from "../domain/seat.js";
import { outcomeVerdictSchema } from "../domain/outcome.js";
import { contract } from '../contract-runtime.js'; /* augur-inject:import:ecef76b6 */
import augurContract_19122134 from '../contracts/outcome-stats.contract.js'; /* augur-inject:contract-predicate:5c59bb44 */

/** 集計 SQL の 1 行 (席 × verdict の件数)。seat = null は席の無いカード。 */
export interface OutcomeStatRow {
  seat: string | null;
  verdict: string;
  count: number;
}

export interface OutcomeTally {
  total: number;
  match: number;
  mismatch: number;
  /** match / total。記入が 0 件なら null (0% と「まだ無い」を混同しない)。 */
  matchRate: number | null;
}

export interface OutcomeSeatTally extends OutcomeTally {
  /** null = 席の確定していないカード。 */
  seat: JudgmentSeat | null;
}

export interface OutcomeStats extends OutcomeTally {
  /** 絞り込んだ席。null = 全席。 */
  seat: JudgmentSeat | null;
  from: number | null;
  to: number | null;
  /** 席別の内訳 (件数のある席だけ、席の定義順、未分類は最後)。 */
  bySeat: OutcomeSeatTally[];
}

export interface OutcomeStatsQuery {
  seat: JudgmentSeat | null;
  from: number | null;
  to: number | null;
}

function tally(match: number, mismatch: number): OutcomeTally {
  const total = match + mismatch;
  return { total, match, mismatch, matchRate: total === 0 ? null : match / total };
}

/**
 * 席別の一致率 (spec/feature/judgment-outcome.md §5)。
 * `query.seat` を指定するとその席の行だけを数える (内訳もその席だけになる)。
 *
 * @implements SPEC-GENIUS-OUTCOME-STATS
 */
export function summarizeOutcomeStats(
  rows: readonly OutcomeStatRow[],
  query: OutcomeStatsQuery,
): OutcomeStats {
  const counts = new Map<JudgmentSeat | null, { match: number; mismatch: number }>();
  for (const row of rows) {
    const seat = row.seat === null ? null : judgmentSeatSchema.parse(row.seat);
    if (query.seat !== null && seat !== query.seat) continue;
    const entry = counts.get(seat) ?? { match: 0, mismatch: 0 };
    if (outcomeVerdictSchema.parse(row.verdict) === "match") entry.match += row.count;
    else entry.mismatch += row.count;
    counts.set(seat, entry);
  }

  const order = [...judgmentSeatSchema.options, null] as const;
  const bySeat: OutcomeSeatTally[] = [];
  let match = 0;
  let mismatch = 0;
  for (const seat of order) {
    const entry = counts.get(seat);
    if (entry === undefined) continue;
    bySeat.push({ seat, ...tally(entry.match, entry.mismatch) });
    match += entry.match;
    mismatch += entry.mismatch;
  }
  return { seat: query.seat, from: query.from, to: query.to, ...tally(match, mismatch), bySeat };
}
// @ts-expect-error augur-inject
summarizeOutcomeStats = contract(summarizeOutcomeStats, { ...augurContract_19122134, contractId: 'C-4', mode: 'observe', sample: 1, where: 'src/outcome/outcome-stats.ts:50', rule: 'contract-wrap', id: '19122134' }); /* augur-inject:contract-wrap:19122134 */
