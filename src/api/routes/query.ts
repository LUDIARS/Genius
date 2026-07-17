import type { Hono } from "hono";
import { z } from "zod";
import { domainSchema, visibilitySchema } from "../../domain/card.js";
import type { ApiServices } from "../contracts.js";
import { parseOrThrow, readJsonOrThrow } from "../validation.js";

const querySchema = z
  .object({
    text: z.string().trim().min(1).max(100_000),
    domain: domainSchema.optional(),
    visibility: visibilitySchema.optional(),
    k: z.number().int().min(1).max(100).default(8),
  })
  .strict();

export function registerQueryRoute(app: Hono, query: ApiServices["query"]): void {
  app.post("/api/clone/query", async (c) => {
    const input = parseOrThrow(querySchema, await readJsonOrThrow(c));
    return c.json(await query.query(input));
  });
}
