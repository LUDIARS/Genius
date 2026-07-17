import type { Hono } from "hono";
import type { ApiServices } from "../contracts.js";

export function registerStatsRoutes(app: Hono, stats: ApiServices["stats"]): void {
  app.get("/api/clone/stats", async (c) => c.json(await stats.get()));

  app.get("/api/clone/export", async (c) => {
    if (c.req.query("visibility") !== "public") {
      return c.json({ error: "visibility=public is required" }, 400);
    }
    return c.json({ cards: await stats.exportPublic() });
  });
}
