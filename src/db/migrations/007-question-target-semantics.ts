import type { Migration } from "./types.js";

/**
 * Q3 needs two different card target semantics:
 *
 * - `card` is a de-duplication target for a low-confidence or curation gap.
 * - `card-context` is display evidence for a contradiction pair and may occur in
 *   more than one question. Pair de-duplication lives on `card-pair`.
 *
 * Migration 006 used one global UNIQUE constraint, which made the explicit
 * "one card may participate in several pairs" requirement impossible. Category
 * gaps also need a stable target even though they have no card or query row.
 */
export const questionTargetSemanticsMigration: Migration = {
  version: 7,
  name: "question target semantics for contradiction context and category gaps",
  up(database) {
    database.exec(`
      ALTER TABLE question_targets RENAME TO question_targets_v6;

      CREATE TABLE question_targets (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL REFERENCES questions(id),
        target_kind TEXT NOT NULL CHECK (target_kind IN (
          'card', 'card-context', 'card-pair', 'query_log', 'category'
        )),
        target_id TEXT NOT NULL
      );

      INSERT INTO question_targets(id, question_id, target_kind, target_id)
      SELECT id, question_id, target_kind, target_id FROM question_targets_v6;
      DROP TABLE question_targets_v6;

      CREATE INDEX idx_question_targets_question_id
        ON question_targets(question_id);
      CREATE UNIQUE INDEX idx_question_targets_dedupe
        ON question_targets(target_kind, target_id)
        WHERE target_kind IN ('card', 'card-pair', 'query_log', 'category');
    `);
  },
};
