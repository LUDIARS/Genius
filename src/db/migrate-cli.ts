import { loadConfig } from "../config/load-config.js";
import { databaseFilename, openConfiguredDatabase } from "./database.js";
import { runMigrations } from "./migrate.js";

function main(): void {
  const config = loadConfig();
  const database = openConfiguredDatabase(config);
  try {
    const applied = runMigrations(database);
    const result = {
      database: databaseFilename(config),
      appliedMigrations: applied,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    database.close();
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Genius migration failed: ${message}\n`);
  process.exitCode = 1;
}
