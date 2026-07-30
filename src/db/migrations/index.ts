import { initialMigration } from "./001-initial.js";
import { ingestFailuresMigration } from "./002-ingest-failures.js";
import { categoryCardsMigration } from "./003-category-cards.js";
import { cardRetirementMigration } from "./004-card-retirement.js";
import type { Migration } from "./types.js";

export const MIGRATIONS: readonly Migration[] = [
  initialMigration,
  ingestFailuresMigration,
  categoryCardsMigration,
  cardRetirementMigration,
];

export type { Migration } from "./types.js";
