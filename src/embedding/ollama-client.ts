import { normalizeLoopbackHttpUrl } from "../config/loopback-url.js";
import { EmbeddingError, type EmbeddingClient } from "./types.js";
import { validateVector } from "./vector-codec.js";

interface OllamaModelEntry {
  name?: unknown;
  model?: unknown;
}

interface OllamaTagsResponse {
  models?: unknown;
}

interface OllamaEmbedResponse {
  model?: unknown;
  embeddings?: unknown;
}

const READINESS_PROBE_TEXT = "Genius local embedding readiness probe";

export interface OllamaEmbeddingClientOptions {
  baseUrl: string;
  model: string;
  dimension: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Explicit Ollama GPU layer count. Omit to use the daemon's configured default. */
  numGpu?: number;
  /**
   * How long Ollama keeps this model resident after the request (Ollama
   * `keep_alive`, e.g. "30m" or "-1" for indefinitely). Omit to use the
   * daemon default (5 minutes). On hosts where GPU auto-detection is broken
   * (see spec/feature/clone-db.md Section 6), letting the model unload
   * between sparse requests forces a slow reload attempt on the next query;
   * setting an explicit keep-alive avoids that reload tax in production.
   */
  keepAlive?: string;
}

function withoutLatestTag(model: string): string {
  return model.endsWith(":latest") ? model.slice(0, -":latest".length) : model;
}

function modelsMatch(left: string, right: string): boolean {
  return left === right || withoutLatestTag(left) === withoutLatestTag(right);
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export class OllamaEmbeddingClient implements EmbeddingClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #numGpu: number | undefined;
  readonly #keepAlive: string | undefined;
  public readonly model: string;
  public readonly dimension: number;

  public constructor(options: OllamaEmbeddingClientOptions) {
    this.#baseUrl = normalizeLoopbackHttpUrl(options.baseUrl, "Ollama baseUrl");
    this.model = options.model.trim();
    if (this.model === "") throw new EmbeddingError("Ollama model must not be empty");
    if (!Number.isSafeInteger(options.dimension) || options.dimension <= 0) {
      throw new EmbeddingError("Ollama embedding dimension must be a positive integer");
    }
    this.dimension = options.dimension;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new EmbeddingError("Ollama timeout must be a positive integer");
    }
    if (
      options.numGpu !== undefined &&
      (!Number.isSafeInteger(options.numGpu) || options.numGpu < 0)
    ) {
      throw new EmbeddingError("Ollama numGpu must be a non-negative integer");
    }
    this.#numGpu = options.numGpu;
    if (options.keepAlive !== undefined && options.keepAlive.trim() === "") {
      throw new EmbeddingError("Ollama keepAlive must not be empty");
    }
    this.#keepAlive = options.keepAlive;
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const url = endpoint(this.#baseUrl, path);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new EmbeddingError(`Ollama request failed: ${url}`, { cause: error });
    }
    if (!response.ok) {
      throw new EmbeddingError(`Ollama request failed with HTTP ${response.status}`);
    }
    return response;
  }

  async #json<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.#request(path, init);
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new EmbeddingError(`Ollama returned invalid JSON for ${path}`, { cause: error });
    }
  }

  public async assertReady(): Promise<void> {
    const response = await this.#json<OllamaTagsResponse>("/api/tags", { method: "GET" });
    if (!Array.isArray(response.models)) {
      throw new EmbeddingError("Ollama /api/tags response is missing models[]");
    }
    const available = response.models.some((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false;
      const candidate = entry as OllamaModelEntry;
      return [candidate.name, candidate.model].some(
        (value) => typeof value === "string" && modelsMatch(value, this.model),
      );
    });
    if (!available) {
      throw new EmbeddingError(`Ollama model is not pulled: ${this.model}`);
    }
    // A tags-only check cannot detect a broken GPU runner or a model with the
    // wrong output dimension. Probe the exact configured execution path so
    // startup fails before accepting requests.
    await this.embed([READINESS_PROBE_TEXT]);
  }

  public async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index];
      if (text === undefined || text.trim() === "") {
        throw new EmbeddingError(`Embedding input ${index} must not be empty`);
      }
    }

    const response = await this.#json<OllamaEmbedResponse>("/api/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        ...(this.#numGpu === undefined ? {} : { options: { num_gpu: this.#numGpu } }),
        ...(this.#keepAlive === undefined ? {} : { keep_alive: this.#keepAlive }),
      }),
    });
    if (typeof response.model === "string" && !modelsMatch(response.model, this.model)) {
      throw new EmbeddingError(
        `Ollama returned model ${response.model}, expected ${this.model}`,
      );
    }
    if (!Array.isArray(response.embeddings)) {
      throw new EmbeddingError("Ollama /api/embed response is missing embeddings[]");
    }
    if (response.embeddings.length !== texts.length) {
      throw new EmbeddingError(
        `Ollama returned ${response.embeddings.length} embeddings for ${texts.length} inputs`,
      );
    }
    return response.embeddings.map((value, index) => {
      if (!Array.isArray(value) || value.some((component) => typeof component !== "number")) {
        throw new EmbeddingError(`Ollama embedding ${index} is not a numeric array`);
      }
      const vector = value as number[];
      validateVector(vector, this.dimension, `Ollama embedding ${index}`);
      return vector;
    });
  }
}
