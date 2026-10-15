import type { Hono } from "hono";
import { z } from "zod";
import { seatDecisionSchema, seatProposalStatusSchema } from "../../domain/seat.js";
import { CardNotFoundError } from "../../feedback/feedback-service.js";
import { SeatDecisionConflictError } from "../../seats/seat-proposal-service.js";
import type { ApiServices } from "../contracts.js";
import { parseOrThrow, readJsonOrThrow } from "../validation.js";

const listQuerySchema = z.object({
  status: seatProposalStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

const generateSchema = z.object({
  // 1 回の HTTP 要求で判定バックエンドを呼ぶ回数の上限。大量の backfill は CLI で回す。
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

/**
 * S1-4 — 席の分類提案と人間の確定 (spec/feature/judgment-outcome.md §4)。
 * @implements SPEC-GENIUS-SEAT-TAG
 */
export function registerSeatRoutes(app: Hono, seats: ApiServices["seats"]): void {
  app.get("/api/clone/seat-proposals", (c) => {
    const query = parseOrThrow(listQuerySchema, c.req.query());
    return c.json({
      proposals: seats.list(query.status ?? null, query.limit, query.offset),
      coverage: seats.coverage(),
    });
  });

  app.post("/api/clone/seat-proposals/generate", async (c) => {
    const input = parseOrThrow(generateSchema, await readJsonOrThrow(c));
    return c.json(await seats.generate(input.limit));
  });

  app.post("/api/clone/seat-proposals/:id/decision", async (c) => {
    const decision = parseOrThrow(seatDecisionSchema, await readJsonOrThrow(c));
    try {
      return c.json(seats.decide(c.req.param("id"), decision));
    } catch (error) {
      if (error instanceof CardNotFoundError) return c.json({ error: "Card not found" }, 404);
      if (error instanceof SeatDecisionConflictError) return c.json({ error: error.message }, 409);
      throw error;
    }
  });
}
