// C-6 planSeatDecision(proposal, decision): only pending proposals are decided,
// reject never tags the card, confirm uses the override or the proposal.

type Proposal = { readonly status: string; readonly proposedSeat: string | null };
type Decision = { readonly action: "confirm" | "reject"; readonly seat?: string | null };
type Plan =
  | { readonly ok: true; readonly status: string; readonly cardSeat: string | null }
  | { readonly ok: false };

export default {
  post: (result: Plan, proposal: Proposal, decision: Decision): true | string => {
    if (proposal.status !== "proposed") {
      return !result.ok || "a decided proposal must not be decided again";
    }
    if (!result.ok) return "a pending proposal must be decidable";
    if (decision.action === "reject") {
      return (result.status === "rejected" && result.cardSeat === null)
        || "reject must not tag the card";
    }
    const expected = decision.seat === undefined ? proposal.proposedSeat : decision.seat;
    return (result.status === "confirmed" && result.cardSeat === expected)
      || "confirm must tag the overriding or the proposed seat";
  },
};
