const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type Environment = Readonly<Record<string, string | undefined>>;

export function normalizeLoopbackBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Invalid Genius base URL: ${value}`, { cause: error });
  }

  if (url.protocol !== "http:") {
    throw new Error("Genius base URL must use http");
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new Error(`Genius base URL must be loopback-only, received host ${url.hostname}`);
  }
  if (url.username || url.password) {
    throw new Error("Genius base URL must not contain credentials");
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("Genius base URL must contain only scheme, loopback host, and port");
  }

  return url.origin;
}

export function resolveGeniusBaseUrl(
  env: Environment = process.env,
  configuredPort?: number,
): string {
  if (env.GENIUS_BASE_URL !== undefined) {
    const explicit = env.GENIUS_BASE_URL.trim();
    if (!explicit) {
      throw new Error("GENIUS_BASE_URL must not be empty");
    }
    return normalizeLoopbackBaseUrl(explicit);
  }

  const rawPort = env.GENIUS_PORT?.trim() ??
    (configuredPort === undefined ? undefined : String(configuredPort));
  if (rawPort === undefined || rawPort.length === 0) {
    throw new Error("Genius port is unavailable; load genius.config.json or set an explicit override");
  }
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`GENIUS_PORT must be an integer, received ${rawPort}`);
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`GENIUS_PORT must be between 1 and 65535, received ${rawPort}`);
  }

  return `http://127.0.0.1:${port}`;
}
