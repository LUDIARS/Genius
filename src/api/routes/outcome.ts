import type { Hono } from "hono";
import { z } from "zod";
import { cardChangeOriginSchema } from "../../domain/card.js";
import { recordOutcomeInputSchema } from "../../domain/outcome.js";
import { judgmentSeatSchema } from "../../domain/seat.js";
import { CardNotFoundError } from "../../feedback/feedback-service.js";
import type { ApiServices } from "../contracts.js";
import { ApiInputError, parseOrThrow, readJsonOrThrow } from "../validation.js";

const putSchema = recordOutcomeInputSchema.extend({
  // 記入経路。discord は relay だけが使うので HTTP からは受けない。
  via: cardChangeOriginSchema.default("api"),
}).strict();

/** epoch ms の整数か、ISO 8601 の日付 / 日時。 */
const instantSchema = z.string().trim().min(1).transform((raw, context) => {
  const value = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    context.addIssue({ code: "custom", message: `Invalid instant: ${raw}` });
    return z.NEVER;
  }
  return value;
});

const statsQuerySchema = z.object({
  seat: judgmentSeatSchema.optional(),
  from: instantSchema.optional(),
  to: instantSchema.optional(),
}).strict();

/**
 * S1-1 / S1-3 — outcome の記入・照会と席別の一致率
 * (spec/feature/judgment-outcome.md §2・§5)。
 *
 * outcome の本文 (採用した判断 / 実際の結果) は判断者の自由文なので、
 * card-feedback の note と同じく loopback / 許可 origin のガードの内側にだけ置き、
 * 公開 export には出さない。
 *
 * @implements SPEC-GENIUS-OUTCOME-RECORD
 */
export function registerOutcomeRoutes(app: Hono, outcome: ApiServices["outcome"]): void {
  app.put("/api/clone/cards/:id/outcome", async (c) => {
    const { via, ...input } = parseOrThrow(putSchema, await readJsonOrThrow(c));
    try {
      return c.json(outcome.record(c.req.param("id"), input, via));
    } catch (error) {
      if (error instanceof CardNotFoundError) return c.json({ error: "Card not found" }, 404);
      throw error;
    }
  });

  app.get("/api/clone/cards/:id/outcome", (c) => {
    try {
      // 未記入 (既存カード) は 200 + null。404 はカードが無いときだけ。
      return c.json({ outcome: outcome.get(c.req.param("id")) });
    } catch (error) {
      if (error instanceof CardNotFoundError) return c.json({ error: "Card not found" }, 404);
      throw error;
    }
  });

  // @implements SPEC-GENIUS-OUTCOME-STATS
  app.get("/api/clone/stats/outcome", (c) => {
    const query = parseOrThrow(statsQuerySchema, c.req.query());
    try {
      return c.json(outcome.stats({
        seat: query.seat ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
      }));
    } catch (error) {
      if (error instanceof RangeError) throw new ApiInputError(error.message);
      throw error;
    }
  });
}
