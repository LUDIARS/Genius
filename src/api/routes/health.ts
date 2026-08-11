import type { Hono } from "hono";
import type { ApiServices } from "../contracts.js";

/**
 * `/healthz` = フロントワーカーの生存、`/readyz` = 依存込みの準備状態
 * (spec/feature/operations.md §9)。
 *
 * 生存確認へ依存の確認を混ぜない。混ぜると依存が遅いだけで「落ちている」と
 * 報告され、監視の側が誤検知で埋まる。
 *
 * @implements SPEC-GENIUS-HEALTH-READINESS
 */
export function registerHealthRoute(app: Hono, health: ApiServices["health"]): void {
  app.get("/healthz", (c) => c.json(health.get()));

  app.get("/readyz", async (c) => {
    const status = await health.ready();
    return c.json(status, status.ok ? 200 : 503);
  });
}
