// C-5 toProposedSeat(label): "none" proposes no seat, a seat label proposes
// exactly that seat (labels outside the vocabulary throw before returning).

const SEATS = [
  "quality",
  "team",
  "pm",
  "adjuster",
  "engagement",
  "po",
  "ad",
  "architecture",
  "devops",
];

export default {
  post: (result: string | null, label: string): true | string => {
    if (label === "none") return result === null || "none must propose no seat";
    return (SEATS.includes(label) && result === label) || "a seat label must propose that seat";
  },
};
