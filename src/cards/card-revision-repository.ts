import { ulid } from "ulid";
import type { GeniusDatabase } from "../db/database.js";
import { cardChangeOriginSchema, type CardChangeOrigin } from "../domain/card.js";

export interface CardRevision {
  id: string;
  cardId: string;
  /** Names of the changed clone_cards columns. Card content is never stored here. */
  changedFields: string[];
  changedBy: CardChangeOrigin;
  changedAt: number;
}

interface CardRevisionRow {
  id: string;
  card_id: string;
  changed_fields: string;
  changed_by: CardChangeOrigin;
  changed_at: number;
}

export interface CardRevisionRepositoryOptions {
  idFactory?: () => string;
  clock?: () => number;
}

/**
 * Audit trail for PATCH-driven card changes. Only the changed column names are
 * recorded — never field values — so sensitive card content cannot proliferate
 * through the revision table (spec/feature/operations.md Section 2).
 */
export class CardRevisionRepository {
  readonly #database: GeniusDatabase;
  readonly #idFactory: () => string;
  readonly #clock: () => number;

  public constructor(database: GeniusDatabase, options: CardRevisionRepositoryOptions = {}) {
    this.#database = database;
    this.#idFactory = options.idFactory ?? ulid;
    this.#clock = options.clock ?? Date.now;
  }

  public record(
    cardId: string,
    changedFields: readonly string[],
    changedBy: CardChangeOrigin,
  ): CardRevision {
    if (cardId.trim() === "") throw new Error("revision cardId must not be empty");
    if (changedFields.length === 0) {
      throw new Error("revision changedFields must not be empty");
    }
    if (changedFields.some((field) => field.trim() === "")) {
      throw new Error("revision changedFields must not contain empty names");
    }
    const revision: CardRevision = {
      id: this.#idFactory(),
      cardId,
      changedFields: [...changedFields],
      changedBy: cardChangeOriginSchema.parse(changedBy),
      changedAt: this.#clock(),
    };
    this.#database
      .prepare(
        `INSERT INTO clone_card_revisions(id, card_id, changed_fields, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        revision.id,
        revision.cardId,
        JSON.stringify(revision.changedFields),
        revision.changedBy,
        revision.changedAt,
      );
    return revision;
  }

  public listByCard(cardId: string): CardRevision[] {
    const rows = this.#database
      .prepare<[string], CardRevisionRow>(
        `SELECT id, card_id, changed_fields, changed_by, changed_at
           FROM clone_card_revisions WHERE card_id = ?
          ORDER BY changed_at ASC, id ASC`,
      )
      .all(cardId);
    return rows.map(mapRevisionRow);
  }
}

function mapRevisionRow(row: CardRevisionRow): CardRevision {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.changed_fields);
  } catch (error) {
    throw new Error(`Revision ${row.id} has invalid changed_fields JSON`, { cause: error });
  }
  if (!Array.isArray(decoded) || decoded.some((field) => typeof field !== "string")) {
    throw new Error(`Revision ${row.id} changed_fields must be a string array`);
  }
  return {
    id: row.id,
    cardId: row.card_id,
    changedFields: decoded,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  };
}
