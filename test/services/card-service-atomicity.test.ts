import { describe, expect, it } from "vitest";
import { CardRepository } from "../../src/cards/card-repository.js";
import { openDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { DistilledCard } from "../../src/domain/card.js";
import type { PublicCardGate } from "../../src/distill/public-card-gate.js";
import type { EmbeddingClient } from "../../src/embedding/types.js";
import { VectorStore } from "../../src/embedding/vector-store.js";
import { CardService } from "../../src/services/card-service.js";

const passThroughGate: PublicCardGate = {
  check: async (card) => card,
};

class BarrierEmbedder implements EmbeddingClient {
  readonly model = "fixed";
  readonly dimension = 1024;
  #calls = 0;
  #release: (() => void) | null = null;
  readonly #barrier = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  async assertReady(): Promise<void> {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.#calls += 1;
    if (this.#calls === 2) this.#release?.();
    await this.#barrier;
    return texts.map(() => [1, ...new Array<number>(1023).fill(0)]);
  }
}

class FixedEmbedder implements EmbeddingClient {
  readonly model = "fixed";
  readonly dimension = 1024;

  async assertReady(): Promise<void> {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map(() => [1, ...new Array<number>(1023).fill(0)]);
  }
}

describe("CardService transactional integrity", () => {
  it("deduplicates concurrent writes by sourceRef", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const cards = new CardRepository(database);
      const service = new CardService(
        database,
        cards,
        new BarrierEmbedder(),
        new VectorStore(database),
        passThroughGate,
      );
      const input = {
        ...card(),
        sourceRef: "memory:concurrent.md#card-001",
        sourceTier: 1 as const,
      };

      const [left, right] = await Promise.all([
        service.saveWithEmbedding(input),
        service.saveWithEmbedding(input),
      ]);

      expect(left.id).toBe(right.id);
      expect(cards.count({ includeSuperseded: true })).toBe(1);
      expect(database.prepare("SELECT count(*) AS count FROM clone_vec").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("rolls back a replacement when the old card is already superseded", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const cards = new CardRepository(database);
      const service = new CardService(
        database,
        cards,
        new FixedEmbedder(),
        new VectorStore(database),
        passThroughGate,
      );
      const old = await service.saveWithEmbedding({
        ...card(),
        sourceRef: "memory:old.md#card-001",
        sourceTier: 1,
      });
      const firstReplacement = await service.saveWithEmbedding({
        ...card({ judgment: "First replacement" }),
        sourceRef: "memory:first.md#card-001",
        sourceTier: 1,
      });
      service.markSuperseded(old.id, firstReplacement.id);

      await expect(service.replaceCheckedWithEmbedding({
        ...card({ judgment: "Conflicting replacement" }),
        sourceRef: "memory:conflict.md#card-001",
        sourceTier: 1,
      }, old.id)).rejects.toThrow("already superseded");

      expect(cards.count({ includeSuperseded: true })).toBe(2);
      expect(cards.list({ includeSuperseded: true }).some(
        (stored) => stored.sourceRef === "memory:conflict.md#card-001",
      )).toBe(false);
      expect(database.prepare("SELECT count(*) AS count FROM clone_vec").get()).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("treats a retry that rediscovers its own sourceRef as an idempotent no-op", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const cards = new CardRepository(database);
      const service = new CardService(
        database,
        cards,
        new FixedEmbedder(),
        new VectorStore(database),
        passThroughGate,
      );
      const input = {
        ...card(),
        sourceRef: "memory:retry.md#card-001",
        sourceTier: 1 as const,
      };
      const first = await service.saveWithEmbedding(input);

      const retried = await service.replaceCheckedWithEmbedding(input, first.id);

      expect(retried.id).toBe(first.id);
      expect(cards.requireById(first.id).supersededBy).toBeNull();
      expect(cards.count({ includeSuperseded: true })).toBe(1);
    } finally {
      database.close();
    }
  });
});

function card(overrides: Partial<DistilledCard> = {}): DistilledCard {
  return {
    domain: "work",
    visibility: "sensitive",
    category: null,
    situation: "When two options are viable",
    judgment: "Prefer the reversible option",
    rationale: "It preserves information",
    tags: ["fixture"],
    confidence: 0.9,
    ...overrides,
  };
}
