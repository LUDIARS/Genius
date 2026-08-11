import type { Hono } from "hono";
import { z } from "zod";
import {
  cardFeedbackNoteSchema,
  cardFeedbackRatingSchema,
  cardFeedbackSourceSchema,
} from "../../domain/feedback.js";
import {
  CardFeedbackNotAllowedError,
  CardNotFoundError,
} from "../../feedback/feedback-service.js";
import type { ApiServices } from "../contracts.js";
import { parseOrThrow, readJsonOrThrow } from "../validation.js";

const MAX_RECENT_FEEDBACK = 50;

const recordSchema = z
  .object({
    // HTTP clients retain the public feedback-input shape in their body. The
    // route parameter remains authoritative, so this is compatibility data.
    cardId: z.string().trim().min(1).max(64).optional(),
    // 未知の rating は 400。既定値へ倒すと「送ったのに効いていない」が起きる。
    rating: cardFeedbackRatingSchema,
    /** 由来クエリ (query_log.id)。任意。 */
    queryId: z.string().trim().min(1).max(64).optional(),
    /** 送信元サービス / セッションの識別子。任意。 */
    source: cardFeedbackSourceSchema.optional(),
    note: cardFeedbackNoteSchema.optional(),
    /**
     * public カードしか見せていない経路 (MCP) が立てる。sensitive の id が来たら
     * 受け付けずに 403 にする — 制限を強める向きにしか働かない。
     */
    publicOnly: z.literal(true).optional(),
  })
  .strict();

/** @implements SPEC-GENIUS-CARD-FEEDBACK-HTTP */
export function registerFeedbackRoutes(app: Hono, feedback: ApiServices["feedback"]): void {
  app.post("/api/clone/cards/:id/feedback", async (c) => {
    const { cardId: _cardId, publicOnly, ...input } = parseOrThrow(recordSchema, await readJsonOrThrow(c));
    try {
      const result = feedback.record(c.req.param("id"), input, {
        publicOnly: publicOnly ?? false,
      });
      return c.json(
        { summary: result.summary, archived: result.archived, id: result.entry.id },
        201,
      );
    } catch (error) {
      if (error instanceof CardNotFoundError) return c.json({ error: "Card not found" }, 404);
      if (error instanceof CardFeedbackNotAllowedError) {
        return c.json({ error: "Card is not available" }, 403);
      }
      throw error;
    }
  });

  // note を含むので loopback / 許可 origin だけが届く既存のガードの内側に置く。
  // 公開 export には出さない (spec/feature/card-feedback.md §3)。
  app.get("/api/clone/cards/:id/feedback", (c) => {
    const cardId = c.req.param("id");
    try {
      return c.json({
        summary: feedback.summary(cardId),
        recent: feedback.recent(cardId, MAX_RECENT_FEEDBACK),
        archivedByFeedback: feedback.isArchivedByFeedback(cardId),
      });
    } catch (error) {
      if (error instanceof CardNotFoundError) return c.json({ error: "Card not found" }, 404);
      throw error;
    }
  });
}
