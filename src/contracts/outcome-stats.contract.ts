// C-4 summarizeOutcomeStats(rows, query): totals add up, matchRate is null for
// zero records, and a seat filter keeps only that seat.

type Tally = {
  readonly seat?: string | null;
  readonly total: number;
  readonly match: number;
  readonly mismatch: number;
  readonly matchRate: number | null;
};
type Stats = Tally & { readonly bySeat: readonly Tally[] };
type Query = { readonly seat: string | null };

function consistent(tally: Tally): boolean {
  if (tally.total !== tally.match + tally.mismatch) return false;
  return tally.total === 0 ? tally.matchRate === null : tally.matchRate === tally.match / tally.total;
}

export default {
  post: (result: Stats, _rows: unknown, query: Query): true | string => {
    if (!consistent(result)) return "overall tally is inconsistent";
    if (!result.bySeat.every(consistent)) return "a per-seat tally is inconsistent";
    if (result.bySeat.reduce((sum, entry) => sum + entry.total, 0) !== result.total) {
      return "per-seat totals must add up to the overall total";
    }
    if (query.seat !== null && result.bySeat.some((entry) => entry.seat !== query.seat)) {
      return "a seat filter must keep only that seat";
    }
    return true;
  },
};
