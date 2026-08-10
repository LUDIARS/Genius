import { ConfigError } from "./errors.js";

const HTTP_ORIGIN_SYNTAX = /^https?:\/\/[^\s/?#\\]+\/?$/i;

/**
 * Validates one entry of `server.allowedOrigins` and returns it in the exact
 * form a browser sends in the `Origin` header (scheme + host + optional port,
 * no trailing slash), so the guard can compare strings without re-parsing.
 *
 * An origin is a front door for an unauthenticated service, so anything that
 * could make two different values look equal — credentials, a path, a query —
 * is refused instead of being normalized away.
 *
 * @implements SPEC-GENIUS-HTTP-ORIGIN-BOUNDARY
 */
export function normalizeAllowedOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ConfigError(`${label} must be an absolute URL`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${label} must use http or https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(`${label} must not contain credentials`);
  }
  // Check the input syntax as well as the parsed URL. WHATWG URL parsing
  // resolves encoded dot segments (for example `/%2e`) to `/`; inspecting
  // url.pathname alone would therefore accept a value that contained a path.
  if (!HTTP_ORIGIN_SYNTAX.test(value)) {
    throw new ConfigError(`${label} must not contain a path, query, or fragment`);
  }
  return url.origin;
}
