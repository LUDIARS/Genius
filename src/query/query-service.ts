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
    if (input.text.trim().length === 0) throw new Error("Query text must not be empty");
    if (!Number.isSafeInteger(input.k) || input.k <= 0 || input.k > 100) {
      throw new Error("Query k must be an integer from 1 through 100");
    }
    const started = this.#clock();
    const embedded = await this.#embedder.embed([input.text]);
    const vector = embedded[0];
    if (!vector || embedded.length !== 1) {
      throw new Error("Query embedder returned an unexpected vector count");
    }
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
