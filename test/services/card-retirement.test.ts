import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRepository } from "../../src/cards/card-repository.js";
import { openDatabase, type GeniusDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { CreateCardInput, DistilledCard } from "../../src/domain/card.js";
import type { PublicCardGate } from "../../src/distill/public-card-gate.js";
import type { EmbeddingClient } from "../../src/embedding/types.js";
import { VectorStore } from "../../src/embedding/vector-store.js";
import { CardService } from "../../src/services/card-service.js";
import { SqliteDistillationCardGateway } from "../../src/services/distillation-card-gateway.js";
import { SqliteQueryVectorPort } from "../../src/services/query-vector-port.js";
import { StatsRepository } from "../../src/stats/stats-repository.js";

const DIMENSION = 1024;

const passThroughGate: PublicCardGate = {
  check: async (card) => card,
};

/** Every card embeds to the same point, so KNN returns them all and only the active filter decides. */
class FixedEmbedder implements EmbeddingClient {
  readonly model = "fixed";
  readonly dimension = DIMENSION;

  async assertReady(): Promise<void> {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map(() => [1, ...new Array<number>(DIMENSION - 1).fill(0)]);
  }
}

function cardInput(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
  return {
    domain: "work",
    visibility: "public",
    category: null,
    situation: "When a stored judgment turns out to be obsolete",
    judgment: "Retire it instead of deleting it",
    rationale: "History stays auditable",
    tags: ["fixture"],
    confidence: 0.9,
    sourceRef: "memory:retire.md#card-001",
    sourceTier: 1,
    ...overrides,
  };
}

describe("card retirement without a replacement", () => {
  let database: GeniusDatabase;
  let cards: CardRepository;
  let service: CardService;
  let vectors: VectorStore;
  let queryPort: SqliteQueryVectorPort;
  let stats: StatsRepository;
  let gateway: SqliteDistillationCardGateway;
  const embedder = new FixedEmbedder();
  const queryVector = [1, ...new Array<number>(DIMENSION - 1).fill(0)];

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    cards = new CardRepository(database);
    vectors = new VectorStore(database, DIMENSION);
    service = new CardService(database, cards, embedder, vectors, passThroughGate);
    queryPort = new SqliteQueryVectorPort(database, DIMENSION);
    stats = new StatsRepository(database);
    gateway = new SqliteDistillationCardGateway(database, embedder, service);
  });

  afterEach(() => database.close());

  it("stores a retirement timestamp and clears it again", async () => {
    const card = await service.saveWithEmbedding(cardInput());
    expect(card.retiredAt).toBeNull();

    const retired = await service.patch(card.id, { retired: true }, "ui");
    expect(typeof retired?.retiredAt).toBe("number");
    expect(cards.requireById(card.id).retiredAt).toBe(retired?.retiredAt);
    // Retiring again is a no-op: the original moment is kept.
    const again = await service.patch(card.id, { retired: true }, "ui");
    expect(again?.retiredAt).toBe(retired?.retiredAt);

    const reactivated = await service.patch(card.id, { retired: false }, "ui");
    expect(reactivated?.retiredAt).toBeNull();
  });

  it("hides a retired card from every active-set reader and brings it back on reactivation", async () => {
    const card = await service.saveWithEmbedding(cardInput());

    await service.patch(card.id, { retired: true }, "ui");

    expect(cards.list()).toEqual([]);
    expect(cards.count()).toBe(0);
    expect(vectors.search(queryVector, 5)).toEqual([]);
    expect(queryPort.search(queryVector, { limit: 5 })).toEqual([]);
    await expect(stats.exportPublic()).resolves.toEqual([]);

    await service.patch(card.id, { retired: false }, "ui");

    expect(cards.list().map((stored) => stored.id)).toEqual([card.id]);
    expect(cards.count()).toBe(1);
    expect(vectors.search(queryVector, 5).map((match) => match.card.id)).toEqual([card.id]);
    expect(queryPort.search(queryVector, { limit: 5 }).map((match) => match.card.id)).toEqual([
      card.id,
    ]);
    await expect(stats.exportPublic()).resolves.toHaveLength(1);
  });

  it("lists a retired card only when includeRetired is requested", async () => {
    const active = await service.saveWithEmbedding(cardInput());
    const retired = await service.saveWithEmbedding(
      cardInput({ sourceRef: "memory:retire.md#card-002" }),
    );
    await service.patch(retired.id, { retired: true }, "ui");

    expect(cards.list().map((stored) => stored.id)).toEqual([active.id]);
    expect(cards.list({ includeRetired: true }).map((stored) => stored.id).sort()).toEqual(
      [active.id, retired.id].sort(),
    );
    expect(cards.count()).toBe(1);
    expect(cards.count({ includeRetired: true })).toBe(2);
  });

  it("stops matching a retired card as a distillation duplicate", async () => {
    const stored = await service.saveWithEmbedding(cardInput());
    const candidate: DistilledCard = {
      domain: stored.domain,
      visibility: stored.visibility,
      category: null,
      situation: stored.situation,
      judgment: stored.judgment,
      rationale: stored.rationale,
      tags: stored.tags,
      confidence: stored.confidence,
    };

    await expect(gateway.findDuplicate(candidate, 0.9)).resolves.toMatchObject({ id: stored.id });

    await service.patch(stored.id, { retired: true }, "ui");

    await expect(gateway.findDuplicate(candidate, 0.9)).resolves.toBeNull();
  });

  it("counts retired cards separately from superseded ones in stats", async () => {
    const replacement = await service.saveWithEmbedding(cardInput());
    const superseded = await service.saveWithEmbedding(
      cardInput({ sourceRef: "memory:retire.md#card-002" }),
    );
    const retired = await service.saveWithEmbedding(
      cardInput({ sourceRef: "memory:retire.md#card-003" }),
    );
    service.markSuperseded(superseded.id, replacement.id);
    await service.patch(retired.id, { retired: true }, "ui");

    const snapshot = await stats.get();

    expect(snapshot.total).toBe(3);
    expect(snapshot.superseded).toBe(1);
    expect(snapshot.retired).toBe(1);
    expect(snapshot.active).toBe(1);
  });

  it("records the retirement in the revision trail as a column name only", async () => {
    const card = await service.saveWithEmbedding(cardInput());

    await service.patch(card.id, { retired: true }, "ui");
    await service.patch(card.id, { retired: false }, "cli");

    const revisions = service.listRevisions(card.id);
    expect(revisions.map((revision) => revision.changedFields)).toEqual([
      ["retired_at"],
      ["retired_at"],
    ]);
    expect(revisions.map((revision) => revision.changedBy)).toEqual(["ui", "cli"]);
  });

  it("keeps retirement and supersede independent", async () => {
    const replacement = await service.saveWithEmbedding(cardInput());
    const card = await service.saveWithEmbedding(
      cardInput({ sourceRef: "memory:retire.md#card-002" }),
    );

    // Retired first, superseded afterwards: neither operation blocks the other.
    await service.patch(card.id, { retired: true }, "ui");
    service.markSuperseded(card.id, replacement.id);
    const both = cards.requireById(card.id);
    expect(both.supersededBy).toBe(replacement.id);
    expect(typeof both.retiredAt).toBe("number");

    // Clearing only the retirement leaves the supersede link — and the card
    // stays out of the active set because of it.
    await service.patch(card.id, { retired: false }, "ui");
    const stillSuperseded = cards.requireById(card.id);
    expect(stillSuperseded.retiredAt).toBeNull();
    expect(stillSuperseded.supersededBy).toBe(replacement.id);
    expect(cards.list().map((stored) => stored.id)).toEqual([replacement.id]);
    expect(cards.list({ includeRetired: true }).map((stored) => stored.id)).toEqual([
      replacement.id,
    ]);
    expect(cards.list({ includeSuperseded: true }).map((stored) => stored.id).sort()).toEqual(
      [card.id, replacement.id].sort(),
    );
  });
});
