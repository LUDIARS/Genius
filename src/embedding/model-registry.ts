import type { GeniusDatabase } from "../db/database.js";
import { EmbeddingError, type ActiveEmbeddingModel } from "./types.js";

interface EmbeddingMetaRow {
  model: string;
  dim: number;
}

export class EmbeddingModelRegistry {
  readonly #database: GeniusDatabase;

  public constructor(database: GeniusDatabase) {
    this.#database = database;
  }

  public getActive(): ActiveEmbeddingModel | null {
    const rows = this.#database
      .prepare<[], EmbeddingMetaRow>(
        "SELECT model, dim FROM embedding_meta WHERE is_active = 1",
      )
      .all();
    if (rows.length > 1) throw new EmbeddingError("More than one embedding model is active");
    const row = rows[0];
    return row === undefined ? null : { model: row.model, dimension: row.dim };
  }

  public ensureActive(model: string, dimension: number): ActiveEmbeddingModel {
    const active = this.getActive();
    if (active === null) {
      this.#database
        .prepare("INSERT INTO embedding_meta(model, dim, is_active) VALUES (?, ?, 1)")
        .run(model, dimension);
      return { model, dimension };
    }
    if (active.model !== model || active.dimension !== dimension) {
      throw new EmbeddingError(
        `Configured embedding ${model}/${dimension} does not match active ` +
          `${active.model}/${active.dimension}`,
      );
    }
    return active;
  }

  public activate(model: string, dimension: number): void {
    this.#database.transaction(() => {
      this.#database.prepare("UPDATE embedding_meta SET is_active = 0 WHERE is_active = 1").run();
      this.#database
        .prepare(
          `INSERT INTO embedding_meta(model, dim, is_active) VALUES (?, ?, 1)
           ON CONFLICT(model) DO UPDATE SET dim = excluded.dim, is_active = 1`,
        )
        .run(model, dimension);
    })();
  }
}
