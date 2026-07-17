import { domainSchema, visibilitySchema, type CloneCard } from "../domain/card.js";
import type { GeniusDatabase } from "../db/database.js";
import {
  CLONE_CARD_COLUMNS,
  mapCloneCardRow,
  type CloneCardRow,
} from "../cards/card-row.js";
import { EmbeddingError } from "./types.js";
import { encodeVector, validateVector } from "./vector-codec.js";

interface VectorMatchRow extends CloneCardRow {
  distance: number;
}

export interface VectorSearchFilters {
  domain?: "work" | "hobby";
  visibility?: "public" | "sensitive";
}

export interface VectorMatch {
  card: CloneCard;
  distance: number;
}

export class VectorStore {
  readonly #database: GeniusDatabase;
  public readonly dimension: number;

  public constructor(database: GeniusDatabase, dimension = 1024) {
    if (dimension !== 1024) {
      throw new EmbeddingError("clone_vec schema requires 1024-dimensional embeddings");
    }
    this.#database = database;
    this.dimension = dimension;
  }

  public insert(cardId: string, vector: readonly number[]): void {
    if (cardId.trim() === "") throw new EmbeddingError("cardId must not be empty");
    validateVector(vector, this.dimension);
    this.#database
      .prepare("INSERT INTO clone_vec(card_id, embedding) VALUES (?, ?)")
      .run(cardId, encodeVector(vector, this.dimension));
  }

  public upsert(cardId: string, vector: readonly number[]): void {
    this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM clone_vec WHERE card_id = ?").run(cardId);
      this.insert(cardId, vector);
    })();
  }

  public remove(cardId: string): boolean {
    return this.#database.prepare("DELETE FROM clone_vec WHERE card_id = ?").run(cardId)
      .changes === 1;
  }

  public clear(): void {
    this.#database.prepare("DELETE FROM clone_vec").run();
  }

  public count(): number {
    const row = this.#database
      .prepare<[], { count: number }>("SELECT count(*) AS count FROM clone_vec")
      .get();
    if (row === undefined) throw new EmbeddingError("Vector count query returned no row");
    return row.count;
  }

  public search(
    queryVector: readonly number[],
    k: number,
    filters: VectorSearchFilters = {},
  ): VectorMatch[] {
    if (!Number.isSafeInteger(k) || k <= 0) {
      throw new EmbeddingError("k must be a positive integer");
    }
    validateVector(queryVector, this.dimension, "query embedding");
    const candidateCount = k * 4;
    if (!Number.isSafeInteger(candidateCount)) throw new EmbeddingError("k is too large");

    const clauses = ["cards.superseded_by IS NULL"];
    const parameters: unknown[] = [
      encodeVector(queryVector, this.dimension),
      candidateCount,
    ];
    if (filters.domain !== undefined) {
      clauses.push("cards.domain = ?");
      parameters.push(domainSchema.parse(filters.domain));
    }
    if (filters.visibility !== undefined) {
      clauses.push("cards.visibility = ?");
      parameters.push(visibilitySchema.parse(filters.visibility));
    }
    parameters.push(k);

    const qualifiedColumns = CLONE_CARD_COLUMNS.split(",")
      .map((column) => `cards.${column.trim()}`)
      .join(", ");
    const rows = this.#database
      .prepare<unknown[], VectorMatchRow>(
        `WITH matches AS (
           SELECT card_id, distance
           FROM clone_vec
           WHERE embedding MATCH ? AND k = ?
         )
         SELECT ${qualifiedColumns}, matches.distance AS distance
         FROM matches
         JOIN clone_cards AS cards ON cards.id = matches.card_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY matches.distance ASC
         LIMIT ?`,
      )
      .all(...parameters);
    return rows.map((row) => ({ card: mapCloneCardRow(row), distance: row.distance }));
  }
}
