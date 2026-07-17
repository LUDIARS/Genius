import { cardEmbeddingText } from "../domain/card.js";
import type { GeniusDatabase } from "../db/database.js";
import { CardRepository } from "../cards/card-repository.js";
import { CachedEmbeddingClient, EmbeddingCache } from "./cache.js";
import { EmbeddingModelRegistry } from "./model-registry.js";
import { EmbeddingError, type EmbeddingClient } from "./types.js";
import { VectorStore } from "./vector-store.js";

export interface ReembedOptions {
  batchSize?: number;
}

export interface ReembedResult {
  model: string;
  dimension: number;
  cardsReembedded: number;
}

export class ReembedService {
  readonly #database: GeniusDatabase;
  readonly #cards: CardRepository;
  readonly #cache: EmbeddingCache;
  readonly #client: CachedEmbeddingClient;
  readonly #models: EmbeddingModelRegistry;
  readonly #vectors: VectorStore;
  readonly #batchSize: number;

  public constructor(
    database: GeniusDatabase,
    cards: CardRepository,
    cache: EmbeddingCache,
    client: EmbeddingClient,
    models: EmbeddingModelRegistry,
    vectors: VectorStore,
    options: ReembedOptions = {},
  ) {
    if (client.dimension !== vectors.dimension) {
      throw new EmbeddingError(
        `Cannot reembed ${vectors.dimension}-dimensional index with ${client.dimension}-dimensional model`,
      );
    }
    const batchSize = options.batchSize ?? 64;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new EmbeddingError("reembed batchSize must be a positive integer");
    }
    this.#database = database;
    this.#cards = cards;
    this.#cache = cache;
    this.#client = new CachedEmbeddingClient(client, cache);
    this.#models = models;
    this.#vectors = vectors;
    this.#batchSize = batchSize;
  }

  async #precomputeAll(): Promise<number> {
    let afterId: string | null = null;
    let total = 0;
    while (true) {
      const page = this.#cards.listPageAfterId(afterId, this.#batchSize);
      if (page.length === 0) return total;
      await this.#client.embed(page.map(cardEmbeddingText));
      total += page.length;
      afterId = page[page.length - 1]!.id;
    }
  }

  #replaceIndexFromCache(): void {
    this.#vectors.clear();
    let afterId: string | null = null;
    while (true) {
      const page = this.#cards.listPageAfterId(afterId, this.#batchSize);
      if (page.length === 0) return;
      for (const card of page) {
        const vector = this.#cache.require(
          this.#client.model,
          this.#client.dimension,
          cardEmbeddingText(card),
        );
        this.#vectors.insert(card.id, vector);
      }
      afterId = page[page.length - 1]!.id;
    }
  }

  public async run(): Promise<ReembedResult> {
    await this.#client.assertReady();
    const cardsReembedded = await this.#precomputeAll();
    this.#database.transaction(() => {
      this.#replaceIndexFromCache();
      this.#models.activate(this.#client.model, this.#client.dimension);
    })();
    return {
      model: this.#client.model,
      dimension: this.#client.dimension,
      cardsReembedded,
    };
  }
}
