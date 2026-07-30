import { initialMigration } from "./001-initial.js";
import { ingestFailuresMigration } from "./002-ingest-failures.js";
import { categoryCardsMigration } from "./003-category-cards.js";
import type { Migration } from "./types.js";

export const MIGRATIONS: readonly Migration[] = [
  initialMigration,
  ingestFailuresMigration,
  categoryCardsMigration,
];

export type { Migration } from "./types.js";
