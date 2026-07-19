import { performance } from "node:perf_hooks";
import type { QueryInput, QueryResult } from "../api/contracts.js";
import type { CloneCard, ScoredCloneCard } from "../domain/card.js";

export interface QueryEmbeddingPort {
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface VectorCandidate {
  card: CloneCard;
  distance: number;
}

export interface QueryVectorPort {
  search(
    vector: readonly number[],
    options: {
      domain?: QueryInput["domain"];
      visibility?: QueryInput["visibility"];
      limit: number;
    },
  ): VectorCandidate[];
}

export interface QueryServiceOptions {
  clock?: () => number;
  embedder: QueryEmbeddingPort;
  vectors: QueryVectorPort;
}

export class QueryService {
  readonly #clock: () => number;
  readonly #embedder: QueryEmbeddingPort;
  readonly #vectors: QueryVectorPort;

  constructor(options: QueryServiceOptions) {
    this.#clock = options.clock ?? performance.now.bind(performance);
    this.#embedder = options.embedder;
    this.#vectors = options.vectors;
  }

  async query(input: QueryInput): Promise<QueryResult> {
    const [result] = await this.queryMany([input]);
    if (!result) throw new Error("Query batching returned an unexpected result count");
    return result;
  }

  /**
   * Embeds every input's query text in a single embedder call (one Ollama
   * round trip instead of N) and then runs each input's vector search
   * independently. Measured on this host: batching N query embeddings cuts
   * per-query latency roughly 4x versus embedding one query at a time
   * (see spec/feature/clone-db.md Section 6). Intended for callers that
   * already hold several queries at once (e.g. the recall eval harness),
   * not for turning single-query traffic into artificial batches.
   */
  async queryMany(inputs: readonly QueryInput[]): Promise<QueryResult[]> {
    if (inputs.length === 0) return [];
    for (const input of inputs) validateQueryInput(input);

    const started = this.#clock();
    const embedded = await this.#embedder.embed(inputs.map((input) => input.text));
    if (embedded.length !== inputs.length) {
      throw new Error("Query embedder returned an unexpected vector count");
    }

    return inputs.map((input, index) => {
      const vector = embedded[index];
      if (!vector) throw new Error("Query embedder returned an unexpected vector count");
      const candidates = this.#vectors.search(vector, {
        ...(input.domain === undefined ? {} : { domain: input.domain }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        limit: input.k * 4,
      });
      const cards = candidates
        .map(scoreCandidate)
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
        .slice(0, input.k);
      return { cards, tookMs: Math.max(0, this.#clock() - started) };
    });
  }
}

function validateQueryInput(input: QueryInput): void {
  if (input.text.trim().length === 0) throw new Error("Query text must not be empty");
  if (!Number.isSafeInteger(input.k) || input.k <= 0 || input.k > 100) {
    throw new Error("Query k must be an integer from 1 through 100");
  }
}

function scoreCandidate(candidate: VectorCandidate): ScoredCloneCard {
  if (!Number.isFinite(candidate.distance) || candidate.distance < 0) {
    throw new Error(`Vector search returned invalid distance for card ${candidate.card.id}`);
  }
  // Semantic similarity dominates; Tier 1 and confidence only break close semantic matches.
  const semanticScore = 1 / (1 + candidate.distance);
  const tierScore = candidate.card.sourceTier === 1 ? 1 : 0;
  const score = semanticScore * 0.85 + tierScore * 0.08 + candidate.card.confidence * 0.07;
  return { ...candidate.card, score };
}
