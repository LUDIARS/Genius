import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ApiServices } from "./contracts.js";
import { registerCardRoutes } from "./routes/cards.js";
import { registerCategoryRoutes } from "./routes/categories.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerQueryRoute } from "./routes/query.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { ApiInputError, inputErrorResponse } from "./validation.js";

export const MAX_API_BODY_BYTES = 512 * 1024;

export function createApp(services: ApiServices): Hono {
  const app = new Hono();
  app.use("*", bodyLimit({
    maxSize: MAX_API_BODY_BYTES,
    onError: (c) => c.json({ error: "Request body is too large" }, 413),
  }));
  registerHealthRoute(app, services.health);
  registerQueryRoute(app, services.query, services.categories);
  registerCardRoutes(app, services.cards, services.categories);
  registerCategoryRoutes(app, services.categories);
  registerIngestRoutes(app, services.ingest);
  registerStatsRoutes(app, services.stats, services.categories);
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    if (error instanceof ApiInputError) return inputErrorResponse(c, error);
    process.stderr.write(`[api-error] ${error.stack ?? error.message}\n`);
    return c.json({ error: "Internal server error" }, 500);
  });
  return app;
}
