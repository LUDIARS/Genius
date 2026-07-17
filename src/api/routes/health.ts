import type { Hono } from "hono";
import type { ApiServices } from "../contracts.js";

export function registerHealthRoute(app: Hono, health: ApiServices["health"]): void {
  app.get("/healthz", async (c) => {
    const status = await health.get();
    return c.json(status, status.ok ? 200 : 503);
  });
}
