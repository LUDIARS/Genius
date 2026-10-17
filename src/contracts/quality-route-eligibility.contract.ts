// C-10 qualityRouteEligible(card): only public, active cards are classified or
// sent to Elegantia; sensitive / superseded / retired cards never are.

interface CardLike {
  visibility: string;
  supersededBy: string | null;
  retiredAt: number | null;
}

export default {
  post: (result: boolean, card: CardLike): true | string => {
    const expected =
      card.visibility === "public" && card.supersededBy === null && card.retiredAt === null;
    return result === expected || "eligible must equal public && active";
  },
};
