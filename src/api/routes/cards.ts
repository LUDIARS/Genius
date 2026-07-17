import type { Hono } from "hono";
import { z } from "zod";
import {
  cardTagSchema,
  cardTagsSchema,
  cardTextSchema,
  distilledCardSchema,
  domainSchema,
  visibilitySchema,
} from "../../domain/card.js";
import type { ApiServices } from "../contracts.js";
import { parseOrThrow, readJsonOrThrow } from "../validation.js";

const listQuerySchema = z
  .object({
    domain: domainSchema.optional(),
    visibility: visibilitySchema.optional(),
    tag: cardTagSchema.optional(),
    q: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    offset: z.coerce.number().int().min(0).default(0),
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
    situation: cardTextSchema.optional(),
    judgment: cardTextSchema.optional(),
    rationale: cardTextSchema.optional(),
    tags: cardTagsSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    supersededBy: z.string().trim().min(1).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Patch must change at least one field");

export function registerCardRoutes(app: Hono, cards: ApiServices["cards"]): void {
  app.get("/api/clone/cards", async (c) => {
    const input = parseOrThrow(listQuerySchema, c.req.query());
    return c.json({ cards: await cards.list(input) });
  });

  app.get("/api/clone/cards/:id", async (c) => {
    const card = await cards.get(c.req.param("id"));
    return card ? c.json(card) : c.json({ error: "Card not found" }, 404);
  });

  app.post("/api/clone/cards", async (c) => {
    const input = parseOrThrow(manualCardSchema, await readJsonOrThrow(c));
    return c.json(await cards.create(input), 201);
  });

  app.patch("/api/clone/cards/:id", async (c) => {
    const patch = parseOrThrow(patchSchema, await readJsonOrThrow(c));
    const card = await cards.patch(c.req.param("id"), patch);
    return card ? c.json(card) : c.json({ error: "Card not found" }, 404);
  });
}
