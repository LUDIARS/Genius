import type { MiddlewareHandler } from "hono";

/** Methods that mutate state and therefore must carry a JSON body. */
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT"]);

/**
 * Requires `Content-Type: application/json` on mutating requests.
 *
 * The service has no authentication and is reachable from any page the user has
 * open in a browser. A simple HTML form can only send
 * `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`,
 * so demanding JSON removes the no-preflight cross-site write path
 * (spec/feature/operations.md Section 5).
 */
export function jsonContentTypeGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method)) return next();
    const contentType = c.req.header("content-type");
    if (contentType === undefined || !isJsonContentType(contentType)) {
      return c.json({ error: "Content-Type: application/json is required" }, 415);
    }
    return next();
  };
}

function isJsonContentType(value: string): boolean {
  // Strip parameters such as "; charset=utf-8" before comparing the media type.
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json";
}
