// C-7 formatOutcomeFollowupText(card, delayDays): the post names the card but
// never carries situation, rationale or sourceRef, and sensitive cards keep
// their judgment local too.

type Card = {
  readonly id: string;
  readonly visibility: string;
  readonly situation: string;
  readonly judgment: string;
  readonly rationale: string;
  readonly sourceRef: string;
};

export default {
  post: (result: string, card: Card): true | string => {
    if (!result.includes(card.id)) return "the follow-up must name the card";
    for (const field of ["situation", "rationale", "sourceRef"] as const) {
      if (card[field].length >= 8 && result.includes(card[field])) {
        return `${field} must not be posted`;
      }
    }
    if (card.visibility !== "public" && card.judgment.length >= 8 && result.includes(card.judgment)) {
      return "a sensitive judgment must not be posted";
    }
    return true;
  },
};
