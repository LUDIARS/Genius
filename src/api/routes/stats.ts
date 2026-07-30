import type { Hono } from "hono";
import type { ApiServices } from "../contracts.js";
import { assertKnownCategories } from "../validation.js";

export function registerStatsRoutes(
  app: Hono,
  stats: ApiServices["stats"],
  categories: ApiServices["categories"],
): void {
  app.get("/api/clone/stats", async (c) => c.json(await stats.get()));

  app.get("/api/clone/export", async (c) => {
    if (c.req.query("visibility") !== "public") {
      return c.json({ error: "visibility=public is required" }, 400);
    }
    const category = c.req.query("category");
    await assertKnownCategories(categories, category === undefined ? [] : [category]);
    return c.json({ cards: await stats.exportPublic(category) });
  });
}
