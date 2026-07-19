import type { Hono } from "hono";
import { z } from "zod";
import { domainSchema, visibilitySchema } from "../../domain/card.js";
import type { ApiServices } from "../contracts.js";
import { parseOrThrow, readJsonOrThrow } from "../validation.js";

const MAX_BATCH_QUERIES = 50;

const querySchema = z
  .object({
    text: z.string().trim().min(1).max(100_000),
    domain: domainSchema.optional(),
    visibility: visibilitySchema.optional(),
    k: z.number().int().min(1).max(100).default(8),
  })
  .strict();

const batchQuerySchema = z
  .object({
    queries: z.array(querySchema).min(1).max(MAX_BATCH_QUERIES),
  })
  .strict();

export function registerQueryRoute(app: Hono, query: ApiServices["query"]): void {
  app.post("/api/clone/query", async (c) => {
    const input = parseOrThrow(querySchema, await readJsonOrThrow(c));
    return c.json(await query.query(input));
  });

  // Embeds every query in the batch through a single Ollama round trip
  // instead of one per query. See spec/feature/clone-db.md Section 6 for the
  // measured latency gain; intended for callers that already hold several
  // queries at once (e.g. the recall eval harness), not for turning
  // single-query traffic into artificial batches.
  app.post("/api/clone/query-batch", async (c) => {
    const input = parseOrThrow(batchQuerySchema, await readJsonOrThrow(c));
    const results = await query.queryMany(input.queries);
    return c.json({ results });
  });
}
