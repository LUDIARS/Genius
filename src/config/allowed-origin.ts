import { ConfigError } from "./errors.js";

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
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError(`${label} must not contain a query or fragment`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ConfigError(`${label} must not contain a path`);
  }
  return url.origin;
}
