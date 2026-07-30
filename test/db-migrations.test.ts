import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { GeniusDatabase } from "../src/db/database.js";
import { openDatabase, runMigrations } from "../src/db/index.js";

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
        "idx_clone_card_revisions_card_id",
        "idx_embedding_meta_one_active",
      ]),
    );
    const cardColumns = database
      .prepare<[], { name: string }>("PRAGMA table_info('clone_cards')")
      .all()
      .map((column) => column.name);
    expect(cardColumns).toContain("category");
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

  it("seeds the initial controlled category vocabulary exactly once", () => {
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
      "ops-lifecycle",
      "review",
      "workflow",
      "writing",
    ]);
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
});
