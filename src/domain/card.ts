import { z } from "zod";
import { categoryNameSchema } from "./category.js";

export const MAX_CARD_TEXT_LENGTH = 16_384;
export const MAX_CARD_TAG_LENGTH = 128;
export const MAX_CARD_TAG_COUNT = 32;

export const domainSchema = z.enum(["work", "hobby"]);
export const visibilitySchema = z.enum(["public", "sensitive"]);
export const cardTextSchema = z.string().trim().min(1).max(MAX_CARD_TEXT_LENGTH);
export const cardTagSchema = z.string().trim().min(1).max(MAX_CARD_TAG_LENGTH);
export const cardTagsSchema = z.array(cardTagSchema).max(MAX_CARD_TAG_COUNT);

export type CardDomain = z.infer<typeof domainSchema>;
export type CardVisibility = z.infer<typeof visibilitySchema>;

export const distilledCardSchema = z.object({
  domain: domainSchema,
  visibility: visibilitySchema,
  // Shape validation only; membership in the controlled vocabulary is enforced
  // against the card_categories table (DB trigger + API-level checks).
  category: categoryNameSchema.nullable().default(null),
  situation: cardTextSchema,
  judgment: cardTextSchema,
  rationale: cardTextSchema,
  tags: cardTagsSchema.default([]),
  confidence: z.number().min(0).max(1),
});

export type DistilledCard = z.infer<typeof distilledCardSchema>;

export interface CloneCard extends DistilledCard {
  id: string;
  sourceRef: string;
  sourceTier: 1 | 2;
  supersededBy: string | null;
  /**
   * Retirement timestamp (epoch ms) for a card deactivated without a
   * replacement; `null` = not retired. Independent of `supersededBy` — either
   * one takes the card out of the active set.
   */
  retiredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScoredCloneCard extends CloneCard {
  score: number;
}

export interface CreateCardInput extends DistilledCard {
  sourceRef: string;
  sourceTier: 1 | 2;
}

/** Caller identity recorded with card revisions (no authentication exists). */
export const cardChangeOriginSchema = z.enum(["ui", "api", "cli"]);

export type CardChangeOrigin = z.infer<typeof cardChangeOriginSchema>;

export interface CardPatch {
  domain?: CardDomain;
  visibility?: CardVisibility;
  category?: string | null;
  situation?: string;
  judgment?: string;
  rationale?: string;
  tags?: string[];
  confidence?: number;
  supersededBy?: string | null;
  /**
   * Retire (`true`) or reactivate (`false`) the card. The intent is what a
   * caller can state; the timestamp itself is stamped by the repository clock,
   * so no caller can backdate a retirement. Reading side is the stored
   * `retiredAt` value (see CloneCard).
   */
  retired?: boolean;
}

export function cardEmbeddingText(
  card: Pick<CloneCard | DistilledCard, "situation" | "judgment" | "rationale">,
): string {
  return `${card.situation}\n${card.judgment}\n${card.rationale}`;
}
