import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { GeniusDatabase } from "../src/db/database.js";
import { MIGRATIONS, openDatabase, runMigrations } from "../src/db/index.js";

const databases: GeniusDatabase[] = [];

function migratedMemoryDatabase(): GeniusDatabase {
  const database = openDatabase(":memory:");
  databases.push(database);
  runMigrations(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("database migrations", () => {
  it("creates every specified table and migration/cache support idempotently", () => {
    const database = migratedMemoryDatabase();
    expect(runMigrations(database)).toEqual([]);

    const rows = database
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table', 'view') ORDER BY name`,
      )
      .all();
    const names = rows.map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "clone_cards",
        "clone_vec",
        "card_categories",
        "clone_card_revisions",
        "embedding_cache",
        "embedding_meta",
        "ingest_state",
        "distill_runs",
        "schema_migrations",
        "query_log",
        "questions",
        "question_targets",
        "question_answers",
        "card_feedback",
      ]),
    );
    const indexes = database
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_clone_cards_domain_visibility",
        "idx_clone_cards_source_ref",
        "idx_clone_cards_superseded_by",
        "idx_clone_cards_category",
        "idx_clone_cards_retired_at",
        "idx_clone_cards_decided_by",
        "idx_clone_card_revisions_card_id",
        "idx_query_log_created_at",
        "idx_questions_status",
        "idx_question_targets_question_id",
        "idx_question_targets_dedupe",
        "idx_question_answers_question_id",
        "idx_embedding_meta_one_active",
        "idx_card_feedback_card",
      ]),
    );
    const cardColumns = database
      .prepare<[], { name: string }>("PRAGMA table_info('clone_cards')")
      .all()
      .map((column) => column.name);
    expect(cardColumns).toContain("category");
    expect(cardColumns).toContain("retired_at");
    expect(cardColumns).toContain("retired_reason");
    expect(cardColumns).toContain("feedback_reset_at");
    expect(cardColumns).toContain("decided_by");
    const answerColumns = database
      .prepare<[], { name: string }>("PRAGMA table_info('question_answers')")
      .all()
      .map((column) => column.name);
    expect(answerColumns).toContain("answered_by");
    const cacheColumns = database
      .prepare<[], { name: string }>("PRAGMA table_info('embedding_cache')")
      .all()
      .map((column) => column.name);
    expect(cacheColumns).toContain("format_version");
    const sourceRefIndex = database
      .prepare<[], { name: string; unique: 0 | 1 }>("PRAGMA index_list('clone_cards')")
      .all()
      .find((index) => index.name === "idx_clone_cards_source_ref");
    expect(sourceRefIndex?.unique).toBe(1);
  });

  it("seeds the controlled category vocabulary exactly once", () => {
    const database = migratedMemoryDatabase();
    expect(runMigrations(database)).toEqual([]);

    const names = database
      .prepare<[], { name: string }>("SELECT name FROM card_categories ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(names).toEqual([
      "data-privacy",
      "delegation",
      "general",
      "impl-design",
      "issue-discovery",
      "ops-lifecycle",
      "review",
      "workflow",
      "writing",
    ]);
  });

  it("adds issue-discovery when upgrading an existing version 8 database", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const migrationsThroughVersion8 = MIGRATIONS.filter(
      (migration) => migration.version <= 8,
    );

    expect(runMigrations(database, migrationsThroughVersion8)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(
      database
        .prepare<[string], { count: number }>(
          "SELECT count(*) AS count FROM card_categories WHERE name = ?",
        )
        .get("issue-discovery")?.count,
    ).toBe(0);

    expect(runMigrations(database)).toEqual([9, 10]);
    expect(
      database
        .prepare<[string], { name: string; description: string }>(
          "SELECT name, description FROM card_categories WHERE name = ?",
        )
        .get("issue-discovery"),
    ).toEqual({
      name: "issue-discovery",
      description: "課題発見判断 — 問題の上流原因の指摘・将来リスクの提起・課題の起案",
    });

    expect(runMigrations(database)).toEqual([]);
    expect(
      database
        .prepare<[string], { count: number }>(
          "SELECT count(*) AS count FROM card_categories WHERE name = ?",
        )
        .get("issue-discovery")?.count,
    ).toBe(1);
  });

  it("adds nullable, bounded decision authors without attributing existing rows", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    expect(runMigrations(
      database,
      MIGRATIONS.filter((migration) => migration.version <= 9),
    )).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    database.exec(`
      INSERT INTO clone_cards(
        id, domain, visibility, category, situation, judgment, rationale, tags,
        source_ref, source_tier, confidence, superseded_by, retired_at, created_at, updated_at
      ) VALUES ('CARD1', 'work', 'sensitive', 'review', 's', 'j', 'r', '[]',
        'fixture:card', 1, 1, NULL, NULL, 1, 1);
      INSERT INTO questions(
        id, question, context, category, domain, visibility, gap_kind, status, created_at
      ) VALUES ('Q1', 'q', 'c', 'review', 'work', 'sensitive', 'low-confidence', 'open', 1);
      INSERT INTO question_answers(id, question_id, text, answered_via, card_id, created_at)
      VALUES ('A1', 'Q1', 'a', 'discord', NULL, 1);
    `);

    expect(runMigrations(database)).toEqual([10]);
    expect(database.prepare("SELECT decided_by FROM clone_cards WHERE id = 'CARD1'").get())
      .toEqual({ decided_by: null });
    expect(database.prepare("SELECT answered_by FROM question_answers WHERE id = 'A1'").get())
      .toEqual({ answered_by: null });
    expect(() => database.prepare("UPDATE clone_cards SET decided_by = ? WHERE id = 'CARD1'")
      .run("x".repeat(65))).toThrow();
    expect(() => database.prepare("UPDATE question_answers SET answered_by = '' WHERE id = 'A1'")
      .run()).toThrow();
  });

  it("rejects clone_cards writes whose category is outside card_categories", () => {
    const database = migratedMemoryDatabase();
    const insert = database.prepare(
      `INSERT INTO clone_cards(
         id, domain, visibility, category, situation, judgment, rationale, tags,
         source_ref, source_tier, confidence, superseded_by, created_at, updated_at
       ) VALUES (?, 'work', 'sensitive', ?, 's', 'j', 'r', '[]', ?, 1, 0.5, NULL, 1, 1)`,
    );

    expect(() => insert.run("01CARD1", "not-a-category", "fixture:one")).toThrow(
      /category must exist in card_categories/,
    );
    expect(() => insert.run("01CARD2", "impl-design", "fixture:two")).not.toThrow();
    expect(() => insert.run("01CARD3", null, "fixture:three")).not.toThrow();
    expect(() =>
      database
        .prepare("UPDATE clone_cards SET category = ? WHERE id = ?")
        .run("still-not-a-category", "01CARD2"),
    ).toThrow(/category must exist in card_categories/);
  });

  it("adds retired_at as a partial-indexed nullable column that leaves rows active", () => {
    const database = migratedMemoryDatabase();
    database
      .prepare(
        `INSERT INTO clone_cards(
           id, domain, visibility, category, situation, judgment, rationale, tags,
           source_ref, source_tier, confidence, superseded_by, created_at, updated_at
         ) VALUES (?, 'work', 'public', NULL, 's', 'j', 'r', '[]', ?, 1, 0.5, NULL, 1, 1)`,
      )
      .run("01RETIRE1", "fixture:retire");

    // A row written without the column is active: NULL, not 0.
    expect(
      database
        .prepare<[], { retired_at: number | null }>("SELECT retired_at FROM clone_cards")
        .all(),
    ).toEqual([{ retired_at: null }]);
    const retiredIndex = database
      .prepare<[], { name: string; partial: 0 | 1 }>("PRAGMA index_list('clone_cards')")
      .all()
      .find((index) => index.name === "idx_clone_cards_retired_at");
    expect(retiredIndex?.partial).toBe(1);
  });

  it("uses WAL for a file-backed database", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "genius-db-")), "genius.db");
    const database = openDatabase(filename);
    databases.push(database);

    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("runs a real sqlite-vec KNN query over fixed vectors", () => {
    const database = migratedMemoryDatabase();
    const vector = (first: number, second: number): Buffer => {
      const values = new Float32Array(1024);
      values[0] = first;
      values[1] = second;
      return Buffer.from(values.buffer);
    };
    database
      .prepare("INSERT INTO clone_vec(card_id, embedding) VALUES (?, ?)")
      .run("near", vector(1, 0));
    database
      .prepare("INSERT INTO clone_vec(card_id, embedding) VALUES (?, ?)")
      .run("far", vector(0, 1));

    const rows = database
      .prepare<[Buffer, number], { card_id: string; distance: number }>(
        `SELECT card_id, distance FROM clone_vec
         WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
      )
      .all(vector(0.9, 0.1), 2);
    expect(rows.map((row) => row.card_id)).toEqual(["near", "far"]);
  });

  it("deduplicates question subjects while allowing cards to appear in several pairs", () => {
    const database = migratedMemoryDatabase();
    const insertQuestion = database.prepare(
      `INSERT INTO questions(
         id, question, context, category, domain, visibility, gap_kind, status, created_at
       ) VALUES (?, 'q', 'c', 'general', 'work', 'sensitive', 'contradiction', 'open', 1)`,
    );
    insertQuestion.run("Q1");
    insertQuestion.run("Q2");
    const insertTarget = database.prepare(
      "INSERT INTO question_targets(id, question_id, target_kind, target_id) VALUES (?, ?, ?, ?)",
    );

    expect(() => insertTarget.run("T1", "Q1", "card-context", "CARD1")).not.toThrow();
    expect(() => insertTarget.run("T2", "Q2", "card-context", "CARD1")).not.toThrow();
    expect(() => insertTarget.run("T3", "Q1", "card-pair", "CARD1:CARD2")).not.toThrow();
    expect(() => insertTarget.run("T4", "Q2", "card-pair", "CARD1:CARD2")).toThrow();
    expect(() => insertTarget.run("T5", "Q1", "category", "review")).not.toThrow();
    expect(() => insertTarget.run("T6", "Q2", "category", "review")).toThrow();
  });
});
