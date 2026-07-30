import { describe, expect, it } from "vitest";
import { CardRepository } from "../../src/cards/card-repository.js";
import { CategoryRepository } from "../../src/categories/category-repository.js";
import { openDatabase, type GeniusDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { DistillCompletionRequest, DistillLlm } from "../../src/distill/distill-llm.js";
import type { CloneCard } from "../../src/domain/card.js";
import { CategorizeBackfillService } from "../../src/services/categorize-backfill.js";

class QueueLlm implements DistillLlm {
  readonly requests: DistillCompletionRequest[] = [];
  readonly #responses: string[];

  constructor(responses: string[]) {
    this.#responses = [...responses];
  }

  async assertReady(): Promise<void> {}

  async complete(request: DistillCompletionRequest): Promise<string> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("Fake LLM response queue exhausted");
    return response;
  }
}

function seededDatabase(): GeniusDatabase {
  const database = openDatabase(":memory:");
  runMigrations(database);
  return database;
}

function insertCard(
  database: GeniusDatabase,
  sourceRef: string,
  category: string | null = null,
): CloneCard {
  return new CardRepository(database).create({
    domain: "work",
    visibility: "sensitive",
    category,
    situation: `${sourceRef} situation`,
    judgment: `${sourceRef} judgment`,
    rationale: `${sourceRef} rationale`,
    tags: [],
    confidence: 0.5,
    sourceRef,
    sourceTier: 1,
  });
}

function createService(
  database: GeniusDatabase,
  llm: DistillLlm,
  stdout: (text: string) => void,
): CategorizeBackfillService {
  return new CategorizeBackfillService({
    categories: new CategoryRepository(database).listSync(),
    database,
    llm,
    stdout,
  });
}

describe("CategorizeBackfillService", () => {
  it("classifies only NULL-category cards and reports progress on stdout", async () => {
    const database = seededDatabase();
    try {
      const first = insertCard(database, "fixture:first");
      const second = insertCard(database, "fixture:second");
      const already = insertCard(database, "fixture:already", "general");
      const llm = new QueueLlm([
        JSON.stringify({ category: "impl-design" }),
        JSON.stringify({ category: "workflow" }),
      ]);
      const output: string[] = [];

      const result = await createService(database, llm, (text) => output.push(text)).run();

      expect(result).toEqual({ scanned: 2, categorized: 2 });
      const repository = new CardRepository(database);
      expect(repository.requireById(first.id).category).toBe("impl-design");
      expect(repository.requireById(second.id).category).toBe("workflow");
      expect(repository.requireById(already.id).category).toBe("general");
      // No re-embedding: the backfill never touches the vector table and
      // leaves updated_at unchanged.
      expect(repository.requireById(first.id).updatedAt).toBe(first.updatedAt);
      const joined = output.join("");
      expect(joined).toContain("2 card(s) without a category");
      expect(joined).toContain(`1/2 ${first.id} -> impl-design`);
      expect(joined).toContain(`2/2 ${second.id} -> workflow`);
      expect(joined).toContain("done: 2/2");
      expect(llm.requests.every((request) => request.purpose === "categorize")).toBe(true);
      expect(llm.requests[0]?.systemPrompt).toContain("- `impl-design`");
      expect(llm.requests[0]?.prompt).toContain("fixture:first situation");
      expect(llm.requests[0]?.prompt).not.toContain("rationale");
    } finally {
      database.close();
    }
  });

  it("fails fast on a category outside the controlled vocabulary", async () => {
    const database = seededDatabase();
    try {
      const card = insertCard(database, "fixture:reject");
      const offVocabulary = JSON.stringify({ category: "not-a-category" });
      const llm = new QueueLlm([offVocabulary, offVocabulary, offVocabulary]);

      await expect(createService(database, llm, () => {}).run()).rejects.toThrow(
        "after 3 attempts",
      );
      expect(new CardRepository(database).requireById(card.id).category).toBeNull();
    } finally {
      database.close();
    }
  });
});
