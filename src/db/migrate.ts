import type { GeniusDatabase } from "./database.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";

interface AppliedMigrationRow {
  version: number;
}

function createMigrationTable(database: GeniusDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
}

function assertMigrationSequence(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) {
      throw new Error("Migrations must have strictly increasing positive integer versions");
    }
    previous = migration.version;
  }
}

export function runMigrations(
  database: GeniusDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): number[] {
  assertMigrationSequence(migrations);
  createMigrationTable(database);

  const appliedRows = database
    .prepare<[], AppliedMigrationRow>("SELECT version FROM schema_migrations")
    .all();
  const applied = new Set(appliedRows.map((row) => row.version));
  const newlyApplied: number[] = [];
  const record = database.prepare(
    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.transaction(() => {
      migration.up(database);
      record.run(migration.version, migration.name, Date.now());
    })();
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}
