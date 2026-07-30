import { ConfigError } from "./errors.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function assertLoopbackHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ConfigError(`${label} must be an absolute URL`, { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${label} must use http or https`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConfigError(`${label} must target a loopback host`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(`${label} must not contain credentials`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError(`${label} must not contain a query or fragment`);
  }
  return url;
}

/**
 * Predicate form of {@link assertLoopbackHttpUrl} for request headers. The
 * validation error is intentionally converted into `false` (a malformed or
 * remote `Origin` is simply "not loopback"); the caller is responsible for
 * rejecting the request loudly (spec/feature/operations.md Section 5).
 */
export function isLoopbackOrigin(value: string): boolean {
  try {
    assertLoopbackHttpUrl(value, "Origin");
    return true;
  } catch {
    return false;
  }
}

export function normalizeLoopbackHttpUrl(value: string, label: string): string {
  const url = assertLoopbackHttpUrl(value, label);
  return url.toString().replace(/\/$/, "");
}
