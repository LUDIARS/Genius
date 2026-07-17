import { CLONE_CARD_COLUMNS, mapCloneCardRow, type CloneCardRow } from "../cards/card-row.js";
import type { GeniusDatabase } from "../db/database.js";
import { domainSchema, visibilitySchema } from "../domain/card.js";
import { encodeVector, validateVector } from "../embedding/vector-codec.js";
import type { QueryVectorPort, VectorCandidate } from "../query/query-service.js";

interface CandidateRow extends CloneCardRow {
  distance: number;
}

export class SqliteQueryVectorPort implements QueryVectorPort {
  readonly #database: GeniusDatabase;
  readonly #dimension: number;

  constructor(database: GeniusDatabase, dimension: number) {
    this.#database = database;
    this.#dimension = dimension;
  }

  search(
    vector: readonly number[],
    options: Parameters<QueryVectorPort["search"]>[1],
  ): VectorCandidate[] {
    validateVector(vector, this.#dimension, "query vector");
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      throw new Error("Query candidate limit must be a positive integer");
    }
    const clauses = ["cards.superseded_by IS NULL"];
    const parameters: Array<string | number | Buffer> = [
      encodeVector(vector, this.#dimension),
      options.limit,
    ];
    if (options.domain !== undefined) {
      clauses.push("cards.domain = ?");
      parameters.push(domainSchema.parse(options.domain));
    }
    if (options.visibility !== undefined) {
      clauses.push("cards.visibility = ?");
      parameters.push(visibilitySchema.parse(options.visibility));
    }
    const columns = CLONE_CARD_COLUMNS.split(",")
      .map((column) => `cards.${column.trim()}`)
      .join(", ");
    const rows = this.#database
      .prepare(
        `WITH matches AS (
           SELECT card_id, distance FROM clone_vec
            WHERE embedding MATCH ? AND k = ?
         )
         SELECT ${columns}, matches.distance AS distance
           FROM matches
           JOIN clone_cards AS cards ON cards.id = matches.card_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY matches.distance ASC`,
      )
      .all(...parameters) as CandidateRow[];
    return rows.map((row) => ({ card: mapCloneCardRow(row), distance: row.distance }));
  }
}
