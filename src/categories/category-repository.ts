import type { GeniusDatabase } from "../db/database.js";
import {
  categoryDescriptionSchema,
  categoryNameSchema,
  type CardCategory,
  type CreateCategoryInput,
} from "../domain/category.js";

interface CategoryRow {
  name: string;
  description: string;
  created_at: number;
}

export class CategoryExistsError extends Error {
  constructor(name: string) {
    super(`Category already exists: ${name}`);
    this.name = "CategoryExistsError";
  }
}

export interface CategoryRepositoryOptions {
  clock?: () => number;
}

/**
 * Persistence and lookup for the controlled category vocabulary. The
 * `card_categories` table is the runtime source of truth for which category
 * values exist (spec/feature/operations.md Section 1.1); no other list of
 * category names may be treated as authoritative.
 */
export class CategoryRepository {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;

  public constructor(database: GeniusDatabase, options: CategoryRepositoryOptions = {}) {
    this.#database = database;
    this.#clock = options.clock ?? Date.now;
  }

  public async list(): Promise<CardCategory[]> {
    return this.listSync();
  }

  public listSync(): CardCategory[] {
    const rows = this.#database
      .prepare<[], CategoryRow>(
        "SELECT name, description, created_at FROM card_categories ORDER BY name ASC",
      )
      .all();
    return rows.map(mapCategoryRow);
  }

  public async create(input: CreateCategoryInput): Promise<CardCategory> {
    const name = categoryNameSchema.parse(input.name);
    const description = categoryDescriptionSchema.parse(input.description);
    const category: CardCategory = { name, description, createdAt: this.#clock() };
    const result = this.#database
      .prepare(
        "INSERT OR IGNORE INTO card_categories(name, description, created_at) VALUES (?, ?, ?)",
      )
      .run(category.name, category.description, category.createdAt);
    if (result.changes !== 1) throw new CategoryExistsError(category.name);
    return category;
  }

  /** Returns the input names that are not part of the controlled vocabulary. */
  public async findUnknown(names: readonly string[]): Promise<string[]> {
    const exists = this.#database.prepare<[string], { name: string }>(
      "SELECT name FROM card_categories WHERE name = ?",
    );
    return names.filter((name) => exists.get(name) === undefined);
  }
}

function mapCategoryRow(row: CategoryRow): CardCategory {
  return { name: row.name, description: row.description, createdAt: row.created_at };
}
