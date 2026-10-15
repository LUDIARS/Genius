// C-1 toCardOutcome(row): existing cards (no row) read as null; a row keeps its
// card id and a verdict from the controlled vocabulary.

type Row = { readonly card_id: string } | undefined;
type Outcome = { readonly cardId: string; readonly verdict: string } | null;

export default {
  post: (result: Outcome, row: Row): true | string => {
    if (row === undefined) return result === null || "a missing row must read as null";
    if (result === null) return "a stored row must not read as null";
    if (result.cardId !== row.card_id) return "the outcome must keep its card id";
    return ["match", "mismatch"].includes(result.verdict) || "verdict outside the vocabulary";
  },
};
