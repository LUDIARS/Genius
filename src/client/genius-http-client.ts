import { normalizeLoopbackBaseUrl, resolveGeniusBaseUrl, type Environment } from "./base-url.js";
import { loadConfig, type LoadConfigOptions } from "../config/load-config.js";
import { ingestRunViewSchema, type IngestRunView } from "./ingest-run-contract.js";
import {
  geniusQueryBatchResultSchema,
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
  readonly #baseUrl: string;
  readonly #queryUrl: URL;
  readonly #queryBatchUrl: URL;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GeniusHttpClientOptions) {
    const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
    this.#baseUrl = baseUrl;
    this.#queryUrl = new URL("/api/clone/query", baseUrl);
    this.#queryBatchUrl = new URL("/api/clone/query-batch", baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async query(input: GeniusQueryInput): Promise<GeniusQueryResult> {
    const validatedInput = geniusQueryInputSchema.parse(input);
    const response = await this.#post(this.#queryUrl, validatedInput);
    const body = await this.#readJson(response, "Genius query");

    const parsed = geniusQueryResultSchema.safeParse(body);
    if (!parsed.success) {
      throw new GeniusHttpClientError(
        `Genius query returned an invalid response: ${formatIssues(parsed.error.issues)}`,
      );
    }
    return parsed.data;
  }

  /** Embeds every input's query in a single Ollama round trip via /api/clone/query-batch. */
  async queryMany(inputs: readonly GeniusQueryInput[]): Promise<GeniusQueryResult[]> {
    if (inputs.length === 0) return [];
    const validatedInputs = inputs.map((input) => geniusQueryInputSchema.parse(input));
    const response = await this.#post(this.#queryBatchUrl, { queries: validatedInputs });
    const body = await this.#readJson(response, "Genius batch query");

    const parsed = geniusQueryBatchResultSchema.safeParse(body);
    if (!parsed.success) {
      throw new GeniusHttpClientError(
        `Genius batch query returned an invalid response: ${formatIssues(parsed.error.issues)}`,
      );
    }
    if (parsed.data.results.length !== inputs.length) {
      throw new GeniusHttpClientError(
        `Genius batch query returned ${parsed.data.results.length} results for ${inputs.length} inputs`,
      );
    }
    return parsed.data.results;
  }

  /**
   * ingest run の状況取得 (Timer Delegation polling 等の消費側入口)。
   * status は completed-with-errors を含む union — 完了判定には
   * `isIngestRunSuccessful` / `isIngestRunFinished` を使うこと。
   */
  async getIngestRun(id: string): Promise<IngestRunView> {
    const url = new URL(`/api/clone/ingest/runs/${encodeURIComponent(id)}`, this.#baseUrl);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
      });
    } catch (error) {
      throw new GeniusHttpClientError(`Genius request failed: ${url.pathname}`, { cause: error });
    }
    const body = await this.#readJson(response, "Genius ingest run status");

    const parsed = ingestRunViewSchema.safeParse(body);
    if (!parsed.success) {
      throw new GeniusHttpClientError(
        `Genius ingest run status returned an invalid response: ${formatIssues(parsed.error.issues)}`,
      );
    }
    return parsed.data;
  }

  async #post(url: URL, body: unknown): Promise<Response> {
    try {
      return await this.#fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
      });
    } catch (error) {
      throw new GeniusHttpClientError(`Genius request failed: ${url.pathname}`, { cause: error });
    }
  }

  async #readJson(response: Response, label: string): Promise<unknown> {
    if (!response.ok) {
      throw new GeniusHttpClientError(`${label} failed with HTTP ${response.status}`, {
        status: response.status,
      });
    }
    const body = await response.text();
    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      throw new GeniusHttpClientError(`${label} returned invalid JSON`, { cause: error });
    }
  }
}

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
    .join("; ");
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
