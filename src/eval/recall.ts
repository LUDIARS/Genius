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

  let hits = 0;
  let expected = 0;
  for (const record of records) {
    const result = await queryService.query({ text: record.query, k });
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
