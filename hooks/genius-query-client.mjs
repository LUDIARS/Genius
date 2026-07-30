const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Invalid Genius base URL: ${value}`, { cause: error });
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new Error("Genius base URL must use HTTP on a loopback host");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Genius base URL must contain only scheme, loopback host, and port");
  }
  return url.origin;
}

export async function resolveHookBaseUrl(env = process.env, loadConfigImplementation) {
  if (env.GENIUS_BASE_URL !== undefined) {
    const explicit = env.GENIUS_BASE_URL.trim();
    if (!explicit) throw new Error("GENIUS_BASE_URL must not be empty");
    return normalizeBaseUrl(explicit);
  }

  const loadConfig = loadConfigImplementation ??
    (await import("../dist/config/load-config.js")).loadConfig;
  const config = loadConfig({
    environment: env,
    ...(env.GENIUS_CONFIG_PATH ? { configPath: env.GENIUS_CONFIG_PATH } : {}),
  });
  const port = config.port;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Configured Genius port must be between 1 and 65535");
  }
  return `http://127.0.0.1:${port}`;
}

export async function queryGeniusForHook(text, options = {}) {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? await resolveHookBaseUrl(options.env, options.loadConfigImplementation),
  );
  let response;
  try {
    response = await fetchImplementation(new URL("/api/clone/query", baseUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        visibility: "public",
        ...(options.categories === undefined ? {} : { categories: options.categories }),
      }),
      redirect: "error",
    });
  } catch (error) {
    throw new Error("Genius query request failed", { cause: error });
  }

  if (!response.ok) {
    throw new Error(`Genius query failed with HTTP ${response.status}`);
  }
  const body = await response.text();

  let decoded;
  try {
    decoded = JSON.parse(body);
  } catch (error) {
    throw new Error("Genius query returned invalid JSON", { cause: error });
  }
  if (decoded === null || typeof decoded !== "object" || !Array.isArray(decoded.cards)) {
    throw new Error("Genius query response must contain a cards array");
  }
  return decoded.cards.map(projectPublicCard);
}

function projectPublicCard(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Genius query card ${index} must be an object`);
  }
  if (value.visibility !== "public") {
    throw new Error(`Genius query card ${index} is not public`);
  }
  if (value.domain !== "work" && value.domain !== "hobby") {
    throw new Error(`Genius query card ${index} has an invalid domain`);
  }
  if (value.category !== null && typeof value.category !== "string") {
    throw new Error(`Genius query card ${index} has an invalid category`);
  }
  const situation = requireString(value.situation, index, "situation");
  const judgment = requireString(value.judgment, index, "judgment");
  const rationale = requireString(value.rationale, index, "rationale");
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) {
    throw new Error(`Genius query card ${index} has invalid tags`);
  }
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) {
    throw new Error(`Genius query card ${index} has invalid confidence`);
  }
  if (typeof value.score !== "number" || !Number.isFinite(value.score)) {
    throw new Error(`Genius query card ${index} has an invalid score`);
  }
  return {
    domain: value.domain,
    visibility: value.visibility,
    category: value.category,
    situation,
    judgment,
    rationale,
    tags: value.tags,
    confidence: value.confidence,
    score: value.score,
  };
}

function requireString(value, index, field) {
  if (typeof value !== "string") {
    throw new Error(`Genius query card ${index} has an invalid ${field}`);
  }
  return value;
}
