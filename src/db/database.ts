import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { GeniusConfig } from "../config/types.js";

export type GeniusDatabase = Database.Database;

export interface OpenDatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

function ensureDatabaseDirectory(filename: string): void {
  if (filename === ":memory:" || filename.startsWith("file:")) return;
  mkdirSync(dirname(filename), { recursive: true });
}

export function databaseFilename(config: Pick<GeniusConfig, "dataDir">): string {
  return join(config.dataDir, "genius.db");
}

export function openDatabase(
  filename: string,
  options: OpenDatabaseOptions = {},
): GeniusDatabase {
  if (!options.readonly) ensureDatabaseDirectory(filename);
  const database = new Database(filename, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false,
  });

  try {
    sqliteVec.load(database);
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    if (!options.readonly) database.pragma("journal_mode = WAL");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function openConfiguredDatabase(
  config: Pick<GeniusConfig, "dataDir">,
  options: OpenDatabaseOptions = {},
): GeniusDatabase {
  return openDatabase(databaseFilename(config), options);
}
