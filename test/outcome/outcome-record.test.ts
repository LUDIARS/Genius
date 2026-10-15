import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRepository } from "../../src/cards/index.js";
import type { GeniusDatabase } from "../../src/db/database.js";
import { openDatabase, runMigrations } from "../../src/db/index.js";
import { MIGRATIONS } from "../../src/db/migrations/index.js";
import type { CreateCardInput } from "../../src/domain/card.js";
import { toCardOutcome } from "../../src/domain/outcome.js";
import { CardNotFoundError } from "../../src/feedback/feedback-service.js";
import { CardOutcomeRepository } from "../../src/outcome/outcome-repository.js";
import { CardOutcomeService } from "../../src/outcome/outcome-service.js";
import { summarizeOutcomeStats } from "../../src/outcome/outcome-stats.js";

let refSeq = 0;

function input(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
  return {
    domain: "work",
    visibility: "public",
    category: null,
    situation: "A release is ready but one reviewer is away",
    judgment: "Ship behind a feature flag",
    rationale: "The flag keeps the change reversible",
    tags: [],
    confidence: 0.8,
    sourceRef: `memory:fixture.md#outcome-${++refSeq}`,
    sourceTier: 1,
    ...overrides,
  };
}

describe("toCardOutcome", () => {
  it("reads a missing row as null and refuses values outside the vocabulary", () => {
    expect(toCardOutcome(undefined)).toBeNull();
    const row = {
      card_id: "c1",
      adopted_decision: "a",
      actual_result: "r",
      verdict: "match",
      recorded_by: "neco",
      recorded_via: "api",
      recorded_at: 5,
    };
    expect(toCardOutcome(row)).toMatchObject({ cardId: "c1", verdict: "match", recordedAt: 5 });
    expect(() => toCardOutcome({ ...row, verdict: "maybe" })).toThrow();
  });
});

describe("migration 011", () => {
  it("keeps cards written before it readable with a null outcome", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database, MIGRATIONS.filter((migration) => migration.version < 11));
      const cards = new CardRepository(database, { idFactory: () => "old-card" });
      cards.create(input());
      expect(runMigrations(database)).toEqual([11]);
      expect(new CardOutcomeRepository(database).get("old-card")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("enforces the verdict vocabulary in SQL as well", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      new CardRepository(database, { idFactory: () => "c1" }).create(input());
      expect(() => database.prepare(
        `INSERT INTO card_outcomes VALUES ('c1', 'a', 'r', 'maybe', 'neco', 'api', 1)`,
      ).run()).toThrow(/CHECK/);
    } finally {
      database.close();
    }
  });
});

describe("CardOutcomeService", () => {
  let database: GeniusDatabase;
  let cards: CardRepository;
  let service: CardOutcomeService;
  let id = 0;
  let now = 1_000;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    cards = new CardRepository(database, { idFactory: () => `card-${++id}`, clock: () => ++now });
    service = new CardOutcomeService(
      cards,
      new CardOutcomeRepository(database, { clock: () => ++now }),
    );
  });

  afterEach(() => database.close());

  it("records, overwrites and reads outcomes; unknown cards are not found", () => {
    const card = cards.create(input());
    const first = service.record(card.id, {
      adoptedDecision: "Ship behind a feature flag",
      actualResult: "No incident",
      verdict: "match",
      recordedBy: "neco",
    }, "cli");
    const second = service.record(card.id, {
      adoptedDecision: "Waited for the reviewer",
      actualResult: "Shipped a week late",
      verdict: "mismatch",
      recordedBy: "neco",
    }, "ui");

    expect(first.recordedVia).toBe("cli");
    expect(second.recordedAt).toBeGreaterThan(first.recordedAt);
    expect(service.get(card.id)).toEqual(second);
    expect(service.getMany([card.id, "other"]).size).toBe(1);
    expect(() => service.get("missing")).toThrow(CardNotFoundError);
    expect(() => service.record("missing", {
      adoptedDecision: "a",
      actualResult: "r",
      verdict: "match",
      recordedBy: "neco",
    }, "api")).toThrow(CardNotFoundError);
  });

  it("filters stats by the decision date and rejects an empty range", () => {
    const early = cards.create(input());
    const late = cards.create(input());
    for (const card of [early, late]) {
      service.record(card.id, {
        adoptedDecision: "a",
        actualResult: "r",
        verdict: card === early ? "match" : "mismatch",
        recordedBy: "neco",
      }, "api");
    }

    expect(service.stats({ seat: null, from: null, to: late.createdAt })).toMatchObject({
      total: 1,
      match: 1,
    });
    expect(service.stats({ seat: null, from: late.createdAt, to: null })).toMatchObject({
      total: 1,
      mismatch: 1,
    });
    expect(() => service.stats({ seat: null, from: 10, to: 10 })).toThrow(RangeError);
  });
});

describe("summarizeOutcomeStats", () => {
  const rows = [
    { seat: "devops", verdict: "match", count: 3 },
    { seat: "devops", verdict: "mismatch", count: 1 },
    { seat: null, verdict: "mismatch", count: 2 },
    { seat: "quality", verdict: "match", count: 1 },
  ];

  it("returns per-seat rates in seat order with unseated cards last", () => {
    const stats = summarizeOutcomeStats(rows, { seat: null, from: null, to: null });

    expect(stats).toMatchObject({ total: 7, match: 4, mismatch: 3, matchRate: 4 / 7 });
    expect(stats.bySeat.map((entry) => entry.seat)).toEqual(["quality", "devops", null]);
    expect(stats.bySeat[1]).toMatchObject({ total: 4, matchRate: 0.75 });
  });

  it("narrows to one seat and reports null instead of 0% when nothing is recorded", () => {
    expect(summarizeOutcomeStats(rows, { seat: "devops", from: 1, to: 2 })).toMatchObject({
      seat: "devops",
      from: 1,
      to: 2,
      total: 4,
      matchRate: 0.75,
    });
    expect(summarizeOutcomeStats(rows, { seat: "ad", from: null, to: null })).toMatchObject({
      total: 0,
      matchRate: null,
      bySeat: [],
    });
  });
});
