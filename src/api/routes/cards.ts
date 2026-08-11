import type { Hono } from "hono";
import { z } from "zod";
import {
  cardChangeOriginSchema,
  cardTagSchema,
  cardTagsSchema,
  cardTextSchema,
  distilledCardSchema,
  domainSchema,
  visibilitySchema,
} from "../../domain/card.js";
import { categoryNameSchema } from "../../domain/category.js";
import { EMPTY_CARD_FEEDBACK_SUMMARY } from "../../domain/feedback.js";
import { CardPromotionRejectedError } from "../../services/card-service.js";
import type { ApiServices } from "../contracts.js";
import { assertKnownCategories, parseOrThrow, readJsonOrThrow } from "../validation.js";

const listQuerySchema = z
  .object({
    domain: domainSchema.optional(),
    visibility: visibilitySchema.optional(),
    category: categoryNameSchema.optional(),
    tag: cardTagSchema.optional(),
    q: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    // Explicit "true"/"false" rather than a coerced boolean: z.coerce.boolean()
    // would read the string "false" as true.
    includeSuperseded: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    includeRetired: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    sort: z.enum(["createdAt", "confidence"]).default("createdAt"),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();

const manualCardSchema = distilledCardSchema.extend({
  sourceRef: z.string().trim().min(1).max(2000).optional(),
  sourceTier: z.union([z.literal(1), z.literal(2)]).default(1),
}).strict();

const patchSchema = z
  .object({
    domain: domainSchema.optional(),
    visibility: visibilitySchema.optional(),
    category: categoryNameSchema.nullable().optional(),
    situation: cardTextSchema.optional(),
    judgment: cardTextSchema.optional(),
    rationale: cardTextSchema.optional(),
    tags: cardTagsSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    supersededBy: z.string().trim().min(1).nullable().optional(),
    // Retirement is expressed as intent (`true` = retire, `false` = reactivate)
    // rather than as a `retiredAt` timestamp: the caller states what should
    // happen and the server stamps the clock, so no client can backdate a
    // retirement or invent an inconsistent state. The stored timestamp is
    // returned on every card DTO as `retiredAt`.
    retired: z.boolean().optional(),
    // Caller identity for the revision trail; not a card field.
    changedBy: cardChangeOriginSchema.default("api"),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "changedBy"),
    "Patch must change at least one field",
  );

export function registerCardRoutes(
  app: Hono,
  cards: ApiServices["cards"],
  categories: ApiServices["categories"],
  feedback: ApiServices["feedback"],
): void {
  app.get("/api/clone/cards", async (c) => {
    const input = parseOrThrow(listQuerySchema, c.req.query());
    await assertKnownCategories(categories, input.category === undefined ? [] : [input.category]);
    const listed = await cards.list(input);
    const summaries = feedback.summaries(listed.map((card) => card.id));
    return c.json({
      cards: listed.map((card) => ({
        ...card,
        feedback: summaries.get(card.id) ?? EMPTY_CARD_FEEDBACK_SUMMARY,
      })),
    });
  });

  app.get("/api/clone/cards/:id", async (c) => {
    const card = await cards.get(c.req.param("id"));
    return card
      ? c.json({ ...card, feedback: feedback.summary(card.id) })
      : c.json({ error: "Card not found" }, 404);
  });

  // Retirement history for the UI detail view (spec/feature/operations.md §5).
  app.get("/api/clone/cards/:id/supersede-chain", async (c) => {
    const chain = await cards.supersedeChain(c.req.param("id"));
    return chain ? c.json(chain) : c.json({ error: "Card not found" }, 404);
  });

  app.post("/api/clone/cards", async (c) => {
    const input = parseOrThrow(manualCardSchema, await readJsonOrThrow(c));
    await assertKnownCategories(categories, input.category === null ? [] : [input.category]);
    return c.json(await cards.create(input), 201);
  });

  app.patch("/api/clone/cards/:id", async (c) => {
    const { changedBy, ...patch } = parseOrThrow(patchSchema, await readJsonOrThrow(c));
    await assertKnownCategories(
      categories,
      patch.category === undefined || patch.category === null ? [] : [patch.category],
    );
    try {
      const card = await cards.patch(c.req.param("id"), patch, changedBy);
      return card ? c.json(card) : c.json({ error: "Card not found" }, 404);
    } catch (error) {
      if (error instanceof CardPromotionRejectedError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });
}
