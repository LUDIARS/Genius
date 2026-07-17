import { initialMigration } from "./001-initial.js";
import type { Migration } from "./types.js";

export const MIGRATIONS: readonly Migration[] = [initialMigration];

export type { Migration } from "./types.js";
