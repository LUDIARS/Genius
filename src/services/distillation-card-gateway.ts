import type { GeniusDatabase } from "../db/database.js";
import { cardEmbeddingText, type CloneCard, type CreateCardInput, type DistilledCard } from "../domain/card.js";
import { activeCardClause } from "../cards/active-card-sql.js";
import { CLONE_CARD_COLUMNS, mapCloneCardRow, type CloneCardRow } from "../cards/card-row.js";
import type { DistillationCardGateway } from "../distill/distillation-service.js";
import type { EmbeddingClient } from "../embedding/types.js";
import { encodeVector } from "../embedding/vector-codec.js";
import { CardService } from "./card-service.js";

interface DuplicateRow extends CloneCardRow {
  distance: number;
}

export class SqliteDistillationCardGateway implements DistillationCardGateway {
  readonly #database: GeniusDatabase;
  readonly #embedder: EmbeddingClient;
  readonly #cards: CardService;

  constructor(database: GeniusDatabase, embedder: EmbeddingClient, cards: CardService) {
    this.#database = database;
    this.#embedder = embedder;
    this.#cards = cards;
  }

  async findBySourceRef(sourceRef: string): Promise<CloneCard | null> {
    const row = this.#database
      .prepare<[string], CloneCardRow>(
        `SELECT ${CLONE_CARD_COLUMNS} FROM clone_cards WHERE source_ref = ?`,
      )
      .get(sourceRef);
    return row === undefined ? null : mapCloneCardRow(row);
  }

  async findDuplicate(card: DistilledCard, threshold: number): Promise<CloneCard | null> {
    if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
      throw new Error("Duplicate cosine threshold must be between -1 and 1");
    }
    const [vector] = await this.#embedder.embed([cardEmbeddingText(card)]);
    if (!vector) throw new Error("Duplicate detector embedder returned no vector");
    const columns = CLONE_CARD_COLUMNS.split(",")
      .map((column) => `cards.${column.trim()}`)
      .join(", ");
    const row = this.#database
      .prepare<[Buffer, string, string, Buffer, number], DuplicateRow>(
        `SELECT ${columns}, vec_distance_cosine(vec.embedding, ?) AS distance
           FROM clone_vec AS vec
           JOIN clone_cards AS cards ON cards.id = vec.card_id
          WHERE cards.domain = ?
            AND cards.visibility = ?
            AND ${activeCardClause("cards")}
            AND vec_distance_cosine(vec.embedding, ?) < ?
          ORDER BY distance ASC
          LIMIT 1`,
      )
      .get(
        encodeVector(vector, this.#embedder.dimension),
        card.domain,
        card.visibility,
        encodeVector(vector, this.#embedder.dimension),
        1 - threshold,
      );
    return row ? mapCloneCardRow(row) : null;
  }

  saveChecked(input: CreateCardInput): Promise<CloneCard> {
    return this.#cards.saveCheckedWithEmbedding(input);
  }

  replaceChecked(input: CreateCardInput, supersededCardId: string): Promise<CloneCard> {
    return this.#cards.replaceCheckedWithEmbedding(input, supersededCardId);
  }
}
