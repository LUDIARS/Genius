import { z } from "zod";
import {
  cardTagsSchema,
  cardTextSchema,
  domainSchema,
  visibilitySchema,
} from "../domain/card.js";

export const geniusQueryInputSchema = z
  .object({
    text: z.string().trim().min(1).max(100_000),
    domain: domainSchema.optional(),
    visibility: visibilitySchema.optional(),
    k: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export type GeniusQueryInput = z.infer<typeof geniusQueryInputSchema>;

export const scoredCardSchema = z
  .object({
    id: z.string().min(1),
    domain: domainSchema,
    visibility: visibilitySchema,
    situation: cardTextSchema,
    judgment: cardTextSchema,
    rationale: cardTextSchema,
    tags: cardTagsSchema,
    sourceRef: z.string(),
    sourceTier: z.union([z.literal(1), z.literal(2)]),
    confidence: z.number().min(0).max(1),
    supersededBy: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    score: z.number(),
  })
  .strict();

export type ScoredCard = z.infer<typeof scoredCardSchema>;

export const geniusQueryResultSchema = z
  .object({
    cards: z.array(scoredCardSchema),
    tookMs: z.number().nonnegative(),
  })
  .strict();

export type GeniusQueryResult = z.infer<typeof geniusQueryResultSchema>;

export const publicSuppliedCardSchema = z
  .object({
    domain: domainSchema,
    visibility: z.literal("public"),
    situation: cardTextSchema,
    judgment: cardTextSchema,
    rationale: cardTextSchema,
    tags: cardTagsSchema,
    confidence: z.number().min(0).max(1),
    score: z.number(),
  })
  .strict();

export type PublicSuppliedCard = z.infer<typeof publicSuppliedCardSchema>;

export const publicGeniusQueryResultSchema = z
  .object({
    cards: z.array(publicSuppliedCardSchema),
    tookMs: z.number().nonnegative(),
  })
  .strict();

export type PublicGeniusQueryResult = z.infer<typeof publicGeniusQueryResultSchema>;

export function toPublicGeniusQueryResult(result: GeniusQueryResult): PublicGeniusQueryResult {
  return {
    cards: result.cards.map((card) => {
      if (card.visibility !== "public") {
        throw new Error("Public Genius surface received a non-public card");
      }
      return {
        domain: card.domain,
        visibility: card.visibility,
        situation: card.situation,
        judgment: card.judgment,
        rationale: card.rationale,
        tags: card.tags,
        confidence: card.confidence,
        score: card.score,
      };
    }),
    tookMs: result.tookMs,
  };
}

export interface GeniusQueryService {
  query(input: GeniusQueryInput): Promise<GeniusQueryResult>;
}
