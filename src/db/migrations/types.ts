import type { GeniusDatabase } from "../database.js";

export interface Migration {
  version: number;
  name: string;
  up(database: GeniusDatabase): void;
}
