import type { Migration } from "./types.js";

interface TableColumnRow {
  name: string;
}

/**
 * Adds replacement-less retirement to `clone_cards`
 * (spec/feature/operations.md Section 5).
 *
 * The state is a nullable timestamp (`retired_at`), not a boolean flag:
 * - `NULL` = active reuses the "absence means active" shape `superseded_by`
 *   already has, so the active predicate stays a pair of `IS NULL` checks and
 *   every existing row is active without a backfill.
 * - the moment of retirement is worth keeping: `clone_card_revisions` records
 *   changed column *names* only (never values), so a boolean would leave no
 *   trace of when a card was taken out of service.
 *
 * Retirement is independent of supersede: a card may be retired, superseded, or
 * both, and each condition alone removes it from the active set.
 */
export const cardRetirementMigration: Migration = {
  version: 4,
  name: "clone_cards.retired_at for replacement-less retirement",
  up(database) {
    // SQLite has no ADD COLUMN IF NOT EXISTS; keep the migration idempotent by hand.
    const columns = database
      .prepare<[], TableColumnRow>("PRAGMA table_info('clone_cards')")
      .all();
    if (!columns.some((column) => column.name === "retired_at")) {
      // No DEFAULT clause: existing rows get NULL, i.e. they stay active.
      database.exec("ALTER TABLE clone_cards ADD COLUMN retired_at INTEGER NULL");
    }

    // Partial index, unlike the plain `superseded_by` index from 001: reads of
    // the active set filter on `retired_at IS NULL`, which will match nearly
    // every row and gains nothing from an index. Only the retired rows are
    // worth indexing — the review WebUI lists them on request — so the index
    // covers just those and stays small.
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_clone_cards_retired_at
        ON clone_cards(retired_at) WHERE retired_at IS NOT NULL;
    `);
  },
};
