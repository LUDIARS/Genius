import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloneCard, CreateCardInput } from "../src/domain/card.js";
import { CardRepository } from "../src/cards/index.js";
import type { GeniusDatabase } from "../src/db/database.js";
import { openDatabase, runMigrations } from "../src/db/index.js";

function input(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
  return {
    domain: "work",
    visibility: "public",
    category: null,
    situation: "A design has multiple viable choices",
    judgment: "Choose the explicit contract",
    rationale: "It keeps failures observable",
    tags: ["design", "failure"],
    confidence: 0.9,
    sourceRef: "memory:fixture.md#decision",
    sourceTier: 1,
    ...overrides,
  };
}

describe("CardRepository", () => {
  let database: GeniusDatabase;
  let repository: CardRepository;
  let id = 0;
  let now = 100;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    repository = new CardRepository(database, {
      idFactory: () => `card-${++id}`,
      clock: () => ++now,
    });
  });

  afterEach(() => database.close());

  it("creates and maps a card without losing JSON tags", () => {
    const created = repository.create(input());

    expect(repository.getById(created.id)).toEqual(created);
    expect(repository.count()).toBe(1);
  });

  it("updates validated fields without deleting history", () => {
    const created = repository.create(input());
    const updated = repository.update(created.id, {
      visibility: "sensitive",
      rationale: "The source contains private context",
    });

    expect(updated.visibility).toBe("sensitive");
    expect(updated.rationale).toContain("private context");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
    expect(repository.count({ includeSuperseded: true })).toBe(1);
  });

  it("filters by quadrant, tag, text, and superseded state", () => {
    const current = repository.create(input());
    const hobby = repository.create(
      input({
        domain: "hobby",
        tags: ["game"],
        sourceRef: "memory:game.md#decision",
      }),
    );
    repository.update(current.id, { supersededBy: hobby.id });

    expect(repository.list({ domain: "work" })).toEqual([]);
    expect(repository.list({ tag: "game" }).map((card: CloneCard) => card.domain)).toEqual([
      "hobby",
    ]);
    expect(repository.list({ query: "viable" })).toHaveLength(1);
    expect(repository.list({ includeSuperseded: true })).toHaveLength(2);
  });

  it("excludes retired cards from list and count until they are requested", () => {
    const active = repository.create(input());
    const retired = repository.create(input({ sourceRef: "memory:retired.md#decision" }));

    const stamped = repository.update(retired.id, { retired: true });

    expect(stamped.retiredAt).toBeGreaterThan(0);
    expect(repository.list().map((card: CloneCard) => card.id)).toEqual([active.id]);
    expect(repository.count()).toBe(1);
    expect(repository.list({ includeRetired: true })).toHaveLength(2);
    expect(repository.count({ includeRetired: true })).toBe(2);
    // Superseded and retired are separate filters: asking for one does not
    // reveal cards excluded by the other.
    expect(repository.list({ includeSuperseded: true }).map((card: CloneCard) => card.id)).toEqual([
      active.id,
    ]);
  });

  it("keeps the first retirement timestamp and clears it on reactivation", () => {
    const created = repository.create(input());

    const retired = repository.update(created.id, { retired: true });
    const retiredAgain = repository.update(created.id, { retired: true });
    const reactivated = repository.update(created.id, { retired: false });

    expect(retiredAgain.retiredAt).toBe(retired.retiredAt);
    expect(reactivated.retiredAt).toBeNull();
  });

  it("rejects a retiredAt value that is not a usable timestamp", () => {
    const created = repository.create(input());

    expect(() => repository.save({ ...created, retiredAt: 0 })).toThrowError(
      /retiredAt must be a positive epoch-millisecond integer/,
    );
    expect(() => repository.save({ ...created, retiredAt: 1.5 })).toThrowError(
      /retiredAt must be a positive epoch-millisecond integer/,
    );
  });

  it("rejects self-supersede and invalid card text", () => {
    const created = repository.create(input());
    expect(() => repository.update(created.id, { supersededBy: created.id })).toThrowError(
      /cannot supersede itself/,
    );
    expect(() => repository.create(input({ situation: " " }))).toThrow();
  });

  it("rejects a supersededBy chain that would form a cycle", () => {
    const first = repository.create(input());
    const second = repository.create(input({ sourceRef: "memory:second.md#decision" }));
    repository.update(first.id, { supersededBy: second.id });

    expect(() => repository.update(second.id, { supersededBy: first.id })).toThrowError(
      /create a cycle/,
    );
    expect(repository.requireById(second.id).supersededBy).toBeNull();
  });
});
