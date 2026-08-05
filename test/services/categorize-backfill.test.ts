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
  // 既定の ULID は同一ミリ秒内で順序が保証されないため、`ORDER BY id ASC` に
  // 依存するテストは id を明示して処理順を固定する。
  id?: string,
): CloneCard {
  const repository = id === undefined
    ? new CardRepository(database)
    : new CardRepository(database, { idFactory: () => id });
  return repository.create({
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

      expect(result).toEqual({ scanned: 2, categorized: 2, failed: 0 });
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

  it("skips a card whose classification keeps failing and continues (Memoria #736)", async () => {
    const database = seededDatabase();
    try {
      const failing = insertCard(database, "fixture:reject", null, "card-1-reject");
      const surviving = insertCard(database, "fixture:survive", null, "card-2-survive");
      const offVocabulary = JSON.stringify({ category: "not-a-category" });
      const llm = new QueueLlm([
        // 1 枚目は 3 回とも統制外カテゴリー → per-card 失敗として skip される。
        offVocabulary,
        offVocabulary,
        offVocabulary,
        JSON.stringify({ category: "workflow" }),
      ]);
      const output: string[] = [];

      const result = await createService(database, llm, (text) => output.push(text)).run();

      expect(result).toEqual({ scanned: 2, categorized: 1, failed: 1 });
      const repository = new CardRepository(database);
      // 失敗カードは NULL のまま残り、次回の categorize --missing が拾い直す。
      expect(repository.requireById(failing.id).category).toBeNull();
      expect(repository.requireById(surviving.id).category).toBe("workflow");
      const joined = output.join("");
      expect(joined).toContain(`1/2 ${failing.id} failed`);
      expect(joined).toContain("1 failed (left NULL for the next run)");
    } finally {
      database.close();
    }
  });

  it("counts a persistence failure as a skipped card and keeps going (Memoria #736)", async () => {
    const database = seededDatabase();
    try {
      const rejected = insertCard(database, "fixture:persist-fails", null, "card-1-rejected");
      const surviving = insertCard(database, "fixture:persist-ok", null, "card-2-survive");
      // UPDATE 側の失敗 (制約違反・trigger など) も per-card 境界で隔離される。
      database.exec(
        "CREATE TRIGGER reject_categorize BEFORE UPDATE OF category ON clone_cards" +
          ` WHEN NEW.id = '${rejected.id}' BEGIN SELECT RAISE(ABORT, 'categorize rejected'); END`,
      );
      const llm = new QueueLlm([
        JSON.stringify({ category: "workflow" }),
        JSON.stringify({ category: "workflow" }),
      ]);
      const output: string[] = [];

      const result = await createService(database, llm, (text) => output.push(text)).run();

      expect(result).toEqual({ scanned: 2, categorized: 1, failed: 1 });
      const repository = new CardRepository(database);
      expect(repository.requireById(rejected.id).category).toBeNull();
      expect(repository.requireById(surviving.id).category).toBe("workflow");
      expect(output.join("")).toContain(`1/2 ${rejected.id} failed`);
    } finally {
      database.close();
    }
  });
});
