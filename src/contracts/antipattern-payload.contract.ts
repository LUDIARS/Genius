// C-9 toElegantiaAntipattern(card): the payload is anchored to the card id
// (genius:card:<id>), never carries the card's ingest sourceRef, and has no
// augur metric (Genius does not invent measurements).

interface CardLike {
  id: string;
  sourceRef: string;
}

interface PayloadLike {
  sourceRef: string;
  augur: unknown;
}

export default {
  post: (result: PayloadLike, card: CardLike): true | string => {
    if (result.sourceRef !== `genius:card:${card.id}`) {
      return "sourceRef must be genius:card:<card id>";
    }
    if (result.augur !== null) return "augur must be null";
    return (
      !JSON.stringify(result).includes(card.sourceRef) ||
      "the payload must not carry the card's ingest sourceRef"
    );
  },
};
