import { z } from "zod";
import { domainSchema, visibilitySchema, type CloneCard } from "../domain/card.js";

/**
 * 能動学習の gap / 質問の共通型 (spec/feature/active-questioning.md §1・§2.1)。
 * 統制語彙 (gap_kind / target_kind) はここが唯一の TypeScript 側の正本で、
 * DB 側の CHECK 制約 (migration 006 + 007) と対で維持する。
 */

export const gapKindSchema = z.enum([
  "low-confidence",
  "contradiction",
  "category-gap",
  "retrieval-miss",
  "curation",
]);

export const questionTargetKindSchema = z.enum([
  "card",
  "card-context",
  "card-pair",
  "query_log",
  "category",
]);

export type GapKind = z.infer<typeof gapKindSchema>;
export type QuestionTargetKind = z.infer<typeof questionTargetKindSchema>;

export interface QuestionTarget {
  kind: QuestionTargetKind;
  id: string;
}

export interface GapEvidence {
  gapKind: GapKind;
  domain: z.infer<typeof domainSchema>;
  visibility: z.infer<typeof visibilitySchema>;
  category: string;
  /** Primary target controls cross-run de-duplication. */
  primaryTarget: QuestionTarget;
  /** Persisted evidence links, including non-deduplicating card-context rows. */
  targets: QuestionTarget[];
  /** Untrusted local-only evidence passed to the distillation backend. */
  promptEvidence: Record<string, unknown>;
}

export interface GeneratedQuestion {
  question: string;
  context: string;
  category: string;
  domain: z.infer<typeof domainSchema>;
  visibility: z.infer<typeof visibilitySchema>;
  gapKind: GapKind;
  targets: QuestionTarget[];
}

export interface QuestionRecord extends GeneratedQuestion {
  id: string;
  status: "open" | "answered" | "dismissed";
  askedAt: number | null;
  answeredAt: number | null;
  discordMessageId: string | null;
  createdAt: number;
}

export interface ContradictionPair {
  left: CloneCard;
  right: CloneCard;
  situationSimilarity: number;
  judgmentSimilarity: number;
}

/**
 * ペア単位の重複排除キー (spec/feature/active-questioning.md §1.1)。
 * `question_targets` はカード単位の行なので、ペアの再質問判定はこの
 * 昇順連結 id を `target_kind = "card-pair"` の 1 行に持たせて行う。
 */
export function canonicalCardPairId(leftId: string, rightId: string): string {
  const ids = [leftId.trim(), rightId.trim()].sort();
  if (ids[0] === "" || ids[1] === "") throw new Error("card pair ids must not be empty");
  if (ids[0] === ids[1]) throw new Error("card pair ids must be distinct");
  return `${ids[0]}:${ids[1]}`;
}
