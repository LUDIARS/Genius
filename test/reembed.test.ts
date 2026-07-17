import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRepository } from "../src/cards/index.js";
import type { GeniusDatabase } from "../src/db/database.js";
import { openDatabase, runMigrations } from "../src/db/index.js";
import {
  EmbeddingCache,
  EmbeddingModelRegistry,
  ReembedService,
  VectorStore,
  type EmbeddingClient,
} from "../src/embedding/index.js";

function vector(first: number): number[] {
  const value = new Array<number>(1024).fill(0);
  value[0] = first;
  return value;
}

describe("ReembedService", () => {
  let database: GeniusDatabase;
  let cards: CardRepository;
  let cache: EmbeddingCache;
  let models: EmbeddingModelRegistry;
  let vectors: VectorStore;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    let id = 0;
    cards = new CardRepository(database, {
      idFactory: () => `card-${++id}`,
      clock: () => id,
    });
    cache = new EmbeddingCache(database, { clock: () => 1 });
    models = new EmbeddingModelRegistry(database);
    vectors = new VectorStore(database);
  });

  afterEach(() => database.close());

  function createCards(): void {
    const first = cards.create({
      domain: "work",
      visibility: "public",
      situation: "first situation",
      judgment: "first judgment",
      rationale: "first rationale",
      tags: [],
      confidence: 1,
      sourceRef: "memory:first",
      sourceTier: 1,
    });
    const second = cards.create({
      domain: "work",
      visibility: "sensitive",
      situation: "second situation",
      judgment: "second judgment",
      rationale: "second rationale",
      tags: [],
      confidence: 0.8,
      sourceRef: "memory:second",
      sourceTier: 2,
    });
    cards.update(first.id, { supersededBy: second.id });
    vectors.upsert(first.id, vector(0.1));
    vectors.upsert(second.id, vector(0.1));
    models.activate("old-model", 1024);
  }

  it("precomputes every card then atomically replaces vectors and active model", async () => {
    createCards();
    const batches: string[][] = [];
    const client: EmbeddingClient = {
      model: "new-model",
      dimension: 1024,
      async assertReady() {},
      async embed(texts) {
        batches.push([...texts]);
        return texts.map((_text, index) => vector(index + 1));
      },
    };
    const service = new ReembedService(
      database,
      cards,
      cache,
      client,
      models,
      vectors,
      { batchSize: 1 },
    );

    await expect(service.run()).resolves.toEqual({
      model: "new-model",
      dimension: 1024,
      cardsReembedded: 2,
    });
    expect(batches).toHaveLength(2);
    expect(vectors.count()).toBe(2);
    expect(models.getActive()).toEqual({ model: "new-model", dimension: 1024 });
  });

  it("leaves the old index and model active when precomputation fails", async () => {
    createCards();
    let calls = 0;
    const client: EmbeddingClient = {
      model: "broken-model",
      dimension: 1024,
      async assertReady() {},
      async embed(texts) {
        calls += 1;
        if (calls === 2) throw new Error("synthetic embedding failure");
        return texts.map(() => vector(1));
      },
    };
    const service = new ReembedService(
      database,
      cards,
      cache,
      client,
      models,
      vectors,
      { batchSize: 1 },
    );

    await expect(service.run()).rejects.toThrow(/synthetic embedding failure/);
    expect(models.getActive()).toEqual({ model: "old-model", dimension: 1024 });
    expect(vectors.count()).toBe(2);
  });
});
