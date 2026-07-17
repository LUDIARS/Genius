import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRepository } from "../src/cards/index.js";
import type { GeniusDatabase } from "../src/db/database.js";
import { openDatabase, runMigrations } from "../src/db/index.js";
import { VectorStore } from "../src/embedding/index.js";

function vector(first: number, second: number): number[] {
  const value = new Array<number>(1024).fill(0);
  value[0] = first;
  value[1] = second;
  return value;
}

describe("VectorStore", () => {
  let database: GeniusDatabase;
  let cards: CardRepository;
  let vectors: VectorStore;
  let sequence = 0;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    cards = new CardRepository(database, {
      idFactory: () => `card-${++sequence}`,
      clock: () => sequence,
    });
    vectors = new VectorStore(database);
  });

  afterEach(() => database.close());

  it("returns real vec0 KNN order and applies quadrant filters", () => {
    const work = cards.create({
      domain: "work",
      visibility: "public",
      situation: "work situation",
      judgment: "work judgment",
      rationale: "work rationale",
      tags: [],
      confidence: 0.9,
      sourceRef: "memory:work",
      sourceTier: 1,
    });
    const hobby = cards.create({
      domain: "hobby",
      visibility: "public",
      situation: "hobby situation",
      judgment: "hobby judgment",
      rationale: "hobby rationale",
      tags: [],
      confidence: 0.8,
      sourceRef: "memory:hobby",
      sourceTier: 1,
    });
    vectors.upsert(work.id, vector(1, 0));
    vectors.upsert(hobby.id, vector(0, 1));

    expect(vectors.search(vector(0.9, 0.1), 2).map((match) => match.card.id)).toEqual([
      work.id,
      hobby.id,
    ]);
    expect(
      vectors.search(vector(0.9, 0.1), 2, { domain: "hobby" }).map((match) =>
        match.card.id,
      ),
    ).toEqual([hobby.id]);
  });

  it("excludes superseded cards and enforces k", () => {
    const first = cards.create({
      domain: "work",
      visibility: "sensitive",
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
      confidence: 1,
      sourceRef: "memory:second",
      sourceTier: 1,
    });
    vectors.upsert(first.id, vector(1, 0));
    vectors.upsert(second.id, vector(0.8, 0.2));
    cards.update(first.id, { supersededBy: second.id });

    expect(vectors.search(vector(1, 0), 1)).toHaveLength(1);
    expect(vectors.search(vector(1, 0), 1)[0]?.card.id).toBe(second.id);
  });

  it("replaces a card vector rather than adding duplicates", () => {
    const card = cards.create({
      domain: "work",
      visibility: "public",
      situation: "situation",
      judgment: "judgment",
      rationale: "rationale",
      tags: [],
      confidence: 1,
      sourceRef: "memory:one",
      sourceTier: 1,
    });
    vectors.upsert(card.id, vector(1, 0));
    vectors.upsert(card.id, vector(0, 1));

    expect(vectors.count()).toBe(1);
    expect(vectors.search(vector(0, 1), 1)[0]?.card.id).toBe(card.id);
  });
});
