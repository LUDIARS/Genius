import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  ContradictionWinnerMismatchError,
  ContradictionWinnerRequiredError,
} from "../../questions/question-answer-service.js";
import {
  QuestionAnswerPendingError,
  QuestionNotFoundError,
  QuestionNotOpenError,
} from "../../questions/question-queue-repository.js";
import { questionStatusSchema } from "../../questions/types.js";
import type { ApiServices } from "../contracts.js";
import { parseOrThrow, readJsonOrThrow } from "../validation.js";

const listQuerySchema = z
  .object({
    status: questionStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const answerSchema = z
  .object({
    text: z.string().trim().min(1).max(16_384),
    winnerCardId: z.string().trim().min(1).max(4_096).optional(),
  })
  .strict();

/**
 * Question queue endpoints for the review UI
 * (spec/interface/api.md 「補完質問」/ spec/feature/active-questioning.md §3.1).
 *
 * Answers arrive only over loopback, so `answeredVia` is fixed to `ui` here;
 * the Discord path (Q6) records its own answers and never reaches these routes.
 *
 * @implements SPEC-GENIUS-ACTIVE-QUESTION-HTTP
 */
export function registerQuestionRoutes(app: Hono, questions: ApiServices["questions"]): void {
  app.get("/api/clone/questions", async (c) => {
    const input = parseOrThrow(listQuerySchema, c.req.query());
    return c.json({ questions: await questions.list(input) });
  });

  app.get("/api/clone/questions/:id", async (c) => {
    const question = await questions.get(c.req.param("id"));
    return question ? c.json(question) : c.json({ error: "Question not found" }, 404);
  });

  app.post("/api/clone/questions/:id/answer", async (c) => {
    const input = parseOrThrow(answerSchema, await readJsonOrThrow(c));
    try {
      const result = await questions.answer({
        questionId: c.req.param("id"),
        text: input.text,
        answeredVia: "ui",
        ...(input.winnerCardId === undefined ? {} : { winnerCardId: input.winnerCardId }),
      });
      return c.json(result, 201);
    } catch (error) {
      return questionErrorResponse(c, error);
    }
  });

  app.post("/api/clone/questions/:id/dismiss", async (c) => {
    try {
      return c.json(await questions.dismiss(c.req.param("id")));
    } catch (error) {
      return questionErrorResponse(c, error);
    }
  });
}

/**
 * Maps the queue's refusals onto status codes. Closed entries, attempts to
 * replace a pending saved answer, and mismatched contradiction winners are
 * caller conflicts (409), never internal errors. Each keeps its own message so
 * the UI can show what the server actually objected to.
 */
function questionErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof QuestionNotFoundError) return c.json({ error: error.message }, 404);
  if (
    error instanceof QuestionNotOpenError
    || error instanceof QuestionAnswerPendingError
    || error instanceof ContradictionWinnerRequiredError
    || error instanceof ContradictionWinnerMismatchError
  ) {
    return c.json({ error: error.message }, 409);
  }
  throw error;
}
