import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ApiServices } from "./contracts.js";
import { jsonContentTypeGuard } from "./middleware/json-content-type-guard.js";
import { originGuard } from "./middleware/origin-guard.js";
import { registerCardRoutes } from "./routes/cards.js";
import { registerCategoryRoutes } from "./routes/categories.js";
import { registerFeedbackRoutes } from "./routes/feedback.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerQueryRoute } from "./routes/query.js";
import { registerQuestionRoutes } from "./routes/questions.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerUiRoutes } from "./routes/ui.js";
import { StaticAssetDirectory } from "./ui/static-asset-directory.js";
import { resolveUiRoot } from "./ui/ui-root.js";
import { ApiInputError, inputErrorResponse } from "./validation.js";

export const MAX_API_BODY_BYTES = 512 * 1024;

export interface CreateAppOptions {
  /** Directory served under `/ui/`. Defaults to the checked-in `ui/` folder. */
  uiRoot?: string;
  /**
   * Non-loopback origins the operator declared in `server.allowedOrigins`.
   * Empty (the default) keeps the browser surface loopback-only.
   */
  allowedOrigins?: readonly string[];
}

export function createApp(services: ApiServices, options: CreateAppOptions = {}): Hono {
  const app = new Hono();
  // Browser-facing guards run first: a cross-origin or form-shaped write is
  // refused before any body is read (spec/feature/operations.md Section 5).
  // No CORS middleware is installed here — cross-origin reads must stay
  // impossible by omission, so do not add one.
  app.use("*", originGuard(options.allowedOrigins ?? []));
  app.use("*", jsonContentTypeGuard());
  app.use("*", bodyLimit({
    maxSize: MAX_API_BODY_BYTES,
    onError: (c) => c.json({ error: "Request body is too large" }, 413),
  }));
  registerUiRoutes(app, new StaticAssetDirectory(options.uiRoot ?? resolveUiRoot()));
  registerHealthRoute(app, services.health);
  registerQueryRoute(app, services.query, services.categories);
  registerCardRoutes(app, services.cards, services.categories, services.feedback);
  registerFeedbackRoutes(app, services.feedback);
  registerCategoryRoutes(app, services.categories);
  registerIngestRoutes(app, services.ingest);
  registerStatsRoutes(app, services.stats, services.categories);
  // @implements SPEC-GENIUS-ACTIVE-QUESTION-HTTP
  registerQuestionRoutes(app, services.questions);
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    if (error instanceof ApiInputError) return inputErrorResponse(c, error);
    process.stderr.write(`[api-error] ${error.stack ?? error.message}\n`);
    return c.json({ error: "Internal server error" }, 500);
  });
  return app;
}
