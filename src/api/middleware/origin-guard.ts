import type { MiddlewareHandler } from "hono";
import { isLoopbackOrigin } from "../../config/loopback-url.js";

/**
 * Rejects any request whose `Origin` header is neither loopback nor one of the
 * origins the operator declared in `server.allowedOrigins`.
 *
 * Requests without `Origin` (curl, the MCP client, the CLI) keep working; a
 * browser page hosted anywhere else is refused instead of being served a CORS
 * denial after the fact. No `Access-Control-Allow-*` header is ever produced —
 * cross-origin reads stay impossible by omission
 * (spec/feature/operations.md Section 5).
 *
 * The allow list exists because Genius can be published through a tunnel that
 * performs the access control Genius itself does not have. It is a list of
 * exact origins, never a pattern: a wildcard here would hand the write API to
 * any page that can guess a hostname.
 *
 * @implements SPEC-GENIUS-HTTP-ORIGIN-BOUNDARY
 */
export function originGuard(allowedOrigins: readonly string[] = []): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);
  /** @implements SPEC-GENIUS-HTTP-ORIGIN-BOUNDARY */
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !isLoopbackOrigin(origin) && !allowed.has(origin)) {
      return c.json({ error: "Cross-origin requests are not allowed" }, 403);
    }
    return next();
  };
}
