import type { MiddlewareHandler } from "hono";
import { isLoopbackOrigin } from "../../config/loopback-url.js";

/**
 * Rejects any request that carries a non-loopback `Origin` header.
 *
 * Requests without `Origin` (curl, the MCP client, the CLI) keep working; a
 * browser page hosted anywhere else is refused instead of being served a CORS
 * denial after the fact. No `Access-Control-Allow-*` header is ever produced —
 * cross-origin reads stay impossible by omission
 * (spec/feature/operations.md Section 5).
 */
export function loopbackOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return c.json({ error: "Cross-origin requests are not allowed" }, 403);
    }
    return next();
  };
}
