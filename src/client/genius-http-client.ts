import { normalizeLoopbackBaseUrl, resolveGeniusBaseUrl, type Environment } from "./base-url.js";
import { loadConfig, type LoadConfigOptions } from "../config/load-config.js";
import {
  geniusQueryInputSchema,
  geniusQueryResultSchema,
  type GeniusQueryInput,
  type GeniusQueryResult,
  type GeniusQueryService,
} from "./query-contract.js";

export interface GeniusHttpClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export class GeniusHttpClientError extends Error {
  readonly status: number | undefined;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GeniusHttpClientError";
    this.status = options?.status;
  }
}

export class GeniusHttpClient implements GeniusQueryService {
  readonly #queryUrl: URL;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GeniusHttpClientOptions) {
    const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
    this.#queryUrl = new URL("/api/clone/query", baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async query(input: GeniusQueryInput): Promise<GeniusQueryResult> {
    const validatedInput = geniusQueryInputSchema.parse(input);

    let response: Response;
    try {
      response = await this.#fetch(this.#queryUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(validatedInput),
        redirect: "error",
      });
    } catch (error) {
      throw new GeniusHttpClientError("Genius query request failed", { cause: error });
    }

    if (!response.ok) {
      throw new GeniusHttpClientError(
        `Genius query failed with HTTP ${response.status}`,
        { status: response.status },
      );
    }
    const body = await response.text();

    let decoded: unknown;
    try {
      decoded = JSON.parse(body) as unknown;
    } catch (error) {
      throw new GeniusHttpClientError("Genius query returned invalid JSON", { cause: error });
    }

    const parsed = geniusQueryResultSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new GeniusHttpClientError(
        `Genius query returned an invalid response: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data;
  }
}

export function createGeniusHttpClientFromEnvironment(
  env: Environment = process.env,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  configOptions: Omit<LoadConfigOptions, "environment"> = {},
): GeniusHttpClient {
  const explicitBaseUrl = env.GENIUS_BASE_URL;
  const configuredPort = explicitBaseUrl === undefined
    ? loadConfig({ ...configOptions, environment: env }).port
    : undefined;
  return new GeniusHttpClient({
    baseUrl: resolveGeniusBaseUrl(env, configuredPort),
    fetch: fetchImplementation,
  });
}
