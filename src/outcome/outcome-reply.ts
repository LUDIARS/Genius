import {
  MAX_OUTCOME_TEXT_LENGTH,
  type OutcomeVerdict,
} from "../domain/outcome.js";
import { contract } from '../contract-runtime.js'; /* augur-inject:import:9c94e34c */
import augurContract_01393c86 from '../contracts/outcome-reply.contract.js'; /* augur-inject:contract-predicate:99ab96b1 */

/**
 * 「結果は?」への返信を outcome に読む (spec/feature/judgment-outcome.md §3.3)。
 *
 * 書式:
 *   1 行目    `一致` / `不一致` (英語 `match` / `mismatch` も可)。続けて結果を書いてよい
 *   `採用:` 行 実際に採用した判断 (省略時はカードの judgment を採用したとみなす)
 *   その他の行 実際の結果
 *
 * 読めない返信は outcome にしない (推測で一致・不一致を決めると的中率が汚れる)。
 */
export type OutcomeReplyParse =
  | {
    ok: true;
    verdict: OutcomeVerdict;
    adoptedDecision: string;
    actualResult: string;
  }
  | { ok: false; reason: string };

// 「不一致」は「一致」を含むので、必ず mismatch 側を先に見る。
const MISMATCH_PATTERN = /^(?:不一致|mismatch)(?=$|[\s:：、,。.!！-])/i;
const MATCH_PATTERN = /^(?:一致|match)(?=$|[\s:：、,。.!！-])/i;
const ADOPTED_PATTERN = /^採用\s*[:：]\s*/;
const LEADING_SEPARATORS = /^[\s:：、,。.!！-]+/;

/** @implements SPEC-GENIUS-OUTCOME-FOLLOWUP */
export function parseOutcomeReply(text: string, cardJudgment: string): OutcomeReplyParse {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const first = lines[0];
  if (first === undefined) return { ok: false, reason: "empty reply" };

  const mismatch = MISMATCH_PATTERN.exec(first);
  const match = mismatch === null ? MATCH_PATTERN.exec(first) : null;
  const head = mismatch ?? match;
  if (head === null) {
    return { ok: false, reason: "the first line must start with 一致 or 不一致" };
  }
  const verdict: OutcomeVerdict = mismatch === null ? "match" : "mismatch";

  let adopted: string | null = null;
  const resultLines: string[] = [];
  const firstRest = first.slice(head[0].length).replace(LEADING_SEPARATORS, "");
  if (firstRest !== "") resultLines.push(firstRest);
  for (const line of lines.slice(1)) {
    if (ADOPTED_PATTERN.test(line)) {
      const value = line.replace(ADOPTED_PATTERN, "").trim();
      if (value !== "") adopted = value;
      continue;
    }
    resultLines.push(line);
  }

  const actualResult = resultLines.join("\n").trim();
  if (actualResult === "") {
    return { ok: false, reason: "the actual result is missing" };
  }
  const adoptedDecision = (adopted ?? cardJudgment).trim();
  if (adoptedDecision === "") return { ok: false, reason: "the adopted decision is missing" };
  if (actualResult.length > MAX_OUTCOME_TEXT_LENGTH || adoptedDecision.length > MAX_OUTCOME_TEXT_LENGTH) {
    return { ok: false, reason: `outcome text exceeds ${MAX_OUTCOME_TEXT_LENGTH} characters` };
  }
  return { ok: true, verdict, adoptedDecision, actualResult };
}
// @ts-expect-error augur-inject
parseOutcomeReply = contract(parseOutcomeReply, { ...augurContract_01393c86, contractId: 'C-2', mode: 'observe', sample: 1, where: 'src/outcome/outcome-reply.ts:32', rule: 'contract-wrap', id: '01393c86' }); /* augur-inject:contract-wrap:01393c86 */
