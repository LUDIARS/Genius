import type { Migration } from "./types.js";

/**
 * Adds the controlled vocabulary entry used to retain human problem-discovery
 * judgments for later retrieval by the issue scout.
 */
export const issueDiscoveryCategoryMigration: Migration = {
  version: 9,
  name: "issue-discovery card category",
  up(database) {
    database
      .prepare(
        "INSERT OR IGNORE INTO card_categories(name, description, created_at) VALUES (?, ?, ?)",
      )
      .run(
        "issue-discovery",
        "課題発見判断 — 問題の上流原因の指摘・将来リスクの提起・課題の起案",
        Date.now(),
      );
  },
};
