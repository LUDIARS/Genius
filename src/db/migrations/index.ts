import { initialMigration } from "./001-initial.js";
import { ingestFailuresMigration } from "./002-ingest-failures.js";
import { categoryCardsMigration } from "./003-category-cards.js";
import { cardRetirementMigration } from "./004-card-retirement.js";
import { queryLogMigration } from "./005-query-log.js";
import { questionsMigration } from "./006-questions.js";
import type { Migration } from "./types.js";

export const MIGRATIONS: readonly Migration[] = [
  initialMigration,
  ingestFailuresMigration,
  categoryCardsMigration,
  cardRetirementMigration,
  queryLogMigration,
  questionsMigration,
];

export type { Migration } from "./types.js";
