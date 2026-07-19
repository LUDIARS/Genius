import type { GeniusQueryService } from "../client/query-contract.js";
import type { GoldRecord } from "./gold-records.js";

export interface RecallEvaluation {
  k: number;
  queries: number;
  expected: number;
  hits: number;
  recall: number;
}

export async function evaluateRecallAtK(
  records: readonly GoldRecord[],
  queryService: GeniusQueryService,
  k = 8,
): Promise<RecallEvaluation> {
  if (!Number.isSafeInteger(k) || k < 1) throw new Error("Recall k must be a positive integer");
  if (records.length === 0) throw new Error("Recall evaluation requires at least one gold record");

  // Batches every gold query's embedding into a single round trip instead of
  // one per record (see QueryService.queryMany / spec/feature/clone-db.md
  // Section 6 for the measured ~4x per-query latency gain).
  const results = await queryService.queryMany(records.map((record) => ({ text: record.query, k })));
  if (results.length !== records.length) {
    throw new Error(`Batched query returned ${results.length} results for ${records.length} records`);
  }

  let hits = 0;
  let expected = 0;
  for (const [index, record] of records.entries()) {
    const result = results[index]!;
    const retrieved = new Set(result.cards.map((card) => card.sourceRef));
    expected += record.expectedSourceRefs.length;
    for (const sourceRef of record.expectedSourceRefs) {
      if (retrieved.has(sourceRef)) hits += 1;
    }
  }

  return {
    k,
    queries: records.length,
    expected,
    hits,
    recall: hits / expected,
  };
}
