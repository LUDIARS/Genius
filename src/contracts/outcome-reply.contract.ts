// C-2 parseOutcomeReply(text, cardJudgment): 不一致 is a mismatch, 一致 a match,
// anything else (or an empty result) is refused instead of guessed.

type Parsed =
  | {
    readonly ok: true;
    readonly verdict: string;
    readonly actualResult: string;
    readonly adoptedDecision: string;
  }
  | { readonly ok: false; readonly reason: string };

export default {
  post: (result: Parsed, text: string): true | string => {
    const first = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "") ?? "";
    const expected = /^(不一致|mismatch)/i.test(first)
      ? "mismatch"
      : /^(一致|match)/i.test(first) ? "match" : null;
    if (!result.ok) return true;
    if (expected === null) return "a reply without 一致/不一致 must be refused";
    if (result.verdict !== expected) return `expected ${expected}, got ${result.verdict}`;
    return (result.actualResult.trim() !== "" && result.adoptedDecision.trim() !== "")
      || "an accepted reply must carry a result and an adopted decision";
  },
};
