import type { Migration } from "./types.js";

interface TableColumnRow {
  name: string;
}

/**
 * Initial controlled vocabulary (spec/feature/operations.md Section 1.1).
 * After seeding, the `card_categories` table is the runtime source of truth;
 * this list only exists to bootstrap it.
 */
const SEED_CATEGORIES: ReadonlyArray<readonly [name: string, description: string]> = [
  ["impl-design", "実装・設計判断"],
  ["review", "レビュー観点・指摘基準"],
  ["ops-lifecycle", "サービス起動・再起動・デプロイ判断"],
  ["delegation", "Codex/Claude 委託の切り方・検証"],
  ["writing", "記事・文体・対外表現"],
  ["data-privacy", "秘匿・レダクション・公開可否"],
  ["workflow", "ブランチ/PR/worktree 等の作業手順"],
  ["general", "上記に収まらないもの (既定)"],
];

export const categoryCardsMigration: Migration = {
  version: 3,
  name: "card categories, clone_cards.category, and card revisions",
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS card_categories (
        name TEXT PRIMARY KEY CHECK (length(trim(name)) > 0),
        description TEXT NOT NULL CHECK (length(trim(description)) > 0),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS clone_card_revisions (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        changed_fields TEXT NOT NULL CHECK (
          json_valid(changed_fields) AND json_type(changed_fields) = 'array'
        ),
        changed_by TEXT NOT NULL CHECK (changed_by IN ('ui', 'api', 'cli')),
        changed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_clone_card_revisions_card_id
        ON clone_card_revisions(card_id);
    `);

    // SQLite has no ADD COLUMN IF NOT EXISTS; keep the migration idempotent by hand.
    const columns = database
      .prepare<[], TableColumnRow>("PRAGMA table_info('clone_cards')")
      .all();
    if (!columns.some((column) => column.name === "category")) {
      database.exec("ALTER TABLE clone_cards ADD COLUMN category TEXT NULL");
    }
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_clone_cards_category ON clone_cards(category)",
    );

    // Enforce the controlled vocabulary at the storage boundary: a category
    // value outside card_categories must fail loudly, never be accepted or
    // silently rewritten (spec/feature/operations.md Section 1.1).
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_clone_cards_category_insert
      BEFORE INSERT ON clone_cards
      WHEN NEW.category IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM card_categories WHERE name = NEW.category)
      BEGIN
        SELECT RAISE(ABORT, 'clone_cards.category must exist in card_categories');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_clone_cards_category_update
      BEFORE UPDATE OF category ON clone_cards
      WHEN NEW.category IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM card_categories WHERE name = NEW.category)
      BEGIN
        SELECT RAISE(ABORT, 'clone_cards.category must exist in card_categories');
      END;
    `);

    const seed = database.prepare(
      "INSERT OR IGNORE INTO card_categories(name, description, created_at) VALUES (?, ?, ?)",
    );
    const now = Date.now();
    for (const [name, description] of SEED_CATEGORIES) {
      seed.run(name, description, now);
    }
  },
};
