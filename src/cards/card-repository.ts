import { ulid } from "ulid";
import {
  distilledCardSchema,
  domainSchema,
  visibilitySchema,
  type CardPatch,
  type CloneCard,
  type CreateCardInput,
} from "../domain/card.js";
import type { GeniusDatabase } from "../db/database.js";
import {
  CLONE_CARD_COLUMNS,
  mapCloneCardRow,
  type CloneCardRow,
} from "./card-row.js";

export interface CardRepositoryOptions {
  idFactory?: () => string;
  clock?: () => number;
}

export interface CardListFilters {
  domain?: "work" | "hobby";
  visibility?: "public" | "sensitive";
  tag?: string;
  query?: string;
  limit?: number;
  offset?: number;
  includeSuperseded?: boolean;
}

export interface CardCountOptions {
  includeSuperseded?: boolean;
}

function assertPaginationInteger(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
}

function normalizeCreateInput(input: CreateCardInput): CreateCardInput {
  const card = distilledCardSchema.parse(input);
  const sourceRef = input.sourceRef.trim();
  if (sourceRef === "") throw new Error("sourceRef must not be empty");
  if (input.sourceTier !== 1 && input.sourceTier !== 2) {
    throw new Error("sourceTier must be 1 or 2");
  }
  return { ...card, sourceRef, sourceTier: input.sourceTier };
}

function assertCloneCard(card: CloneCard): CloneCard {
  const normalized = normalizeCreateInput(card);
  if (card.id.trim() === "") throw new Error("card id must not be empty");
  if (!Number.isSafeInteger(card.createdAt) || !Number.isSafeInteger(card.updatedAt)) {
    throw new Error("card timestamps must be epoch-millisecond integers");
  }
  if (card.supersededBy === card.id) {
    throw new Error("a card cannot supersede itself");
  }
  return {
    ...normalized,
    id: card.id,
    supersededBy: card.supersededBy,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

export class CardRepository {
  readonly #database: GeniusDatabase;
  readonly #idFactory: () => string;
  readonly #clock: () => number;

  public constructor(database: GeniusDatabase, options: CardRepositoryOptions = {}) {
    this.#database = database;
    this.#idFactory = options.idFactory ?? ulid;
    this.#clock = options.clock ?? Date.now;
  }

  public prepareCreate(input: CreateCardInput): CloneCard {
    const normalized = normalizeCreateInput(input);
    const timestamp = this.#clock();
    return {
      ...normalized,
      id: this.#idFactory(),
      supersededBy: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  public create(input: CreateCardInput): CloneCard {
    const card = this.prepareCreate(input);
    this.insert(card);
    return card;
  }

  public insert(card: CloneCard): void {
    const normalized = assertCloneCard(card);
    this.#assertSupersedeChain(normalized.id, normalized.supersededBy);
    this.#database
      .prepare(
        `INSERT INTO clone_cards(
          id, domain, visibility, situation, judgment, rationale, tags,
          source_ref, source_tier, confidence, superseded_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalized.id,
        normalized.domain,
        normalized.visibility,
        normalized.situation,
        normalized.judgment,
        normalized.rationale,
        JSON.stringify(normalized.tags),
        normalized.sourceRef,
        normalized.sourceTier,
        normalized.confidence,
        normalized.supersededBy,
        normalized.createdAt,
        normalized.updatedAt,
      );
  }

  public save(card: CloneCard): void {
    const normalized = assertCloneCard(card);
    this.#assertSupersedeChain(normalized.id, normalized.supersededBy);
    const result = this.#database
      .prepare(
        `UPDATE clone_cards SET
          domain = ?, visibility = ?, situation = ?, judgment = ?, rationale = ?,
          tags = ?, source_ref = ?, source_tier = ?, confidence = ?,
          superseded_by = ?, created_at = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        normalized.domain,
        normalized.visibility,
        normalized.situation,
        normalized.judgment,
        normalized.rationale,
        JSON.stringify(normalized.tags),
        normalized.sourceRef,
        normalized.sourceTier,
        normalized.confidence,
        normalized.supersededBy,
        normalized.createdAt,
        normalized.updatedAt,
        normalized.id,
      );
    if (result.changes !== 1) throw new Error(`Card not found: ${normalized.id}`);
  }

  public getById(id: string): CloneCard | null {
    const row = this.#database
      .prepare<[string], CloneCardRow>(
        `SELECT ${CLONE_CARD_COLUMNS} FROM clone_cards WHERE id = ?`,
      )
      .get(id);
    return row === undefined ? null : mapCloneCardRow(row);
  }

  public requireById(id: string): CloneCard {
    const card = this.getById(id);
    if (card === null) throw new Error(`Card not found: ${id}`);
    return card;
  }

  public preparePatch(card: CloneCard, patch: CardPatch): CloneCard {
    const domain = patch.domain === undefined ? card.domain : domainSchema.parse(patch.domain);
    const visibility =
      patch.visibility === undefined
        ? card.visibility
        : visibilitySchema.parse(patch.visibility);
    const distilled = distilledCardSchema.parse({
      domain,
      visibility,
      situation: patch.situation ?? card.situation,
      judgment: patch.judgment ?? card.judgment,
      rationale: patch.rationale ?? card.rationale,
      tags: patch.tags ?? card.tags,
      confidence: patch.confidence ?? card.confidence,
    });
    const supersededBy =
      patch.supersededBy === undefined ? card.supersededBy : patch.supersededBy;
    if (supersededBy === card.id) throw new Error("a card cannot supersede itself");
    this.#assertSupersedeChain(card.id, supersededBy);
    return {
      ...card,
      ...distilled,
      supersededBy,
      updatedAt: this.#clock(),
    };
  }

  public update(id: string, patch: CardPatch): CloneCard {
    const updated = this.preparePatch(this.requireById(id), patch);
    this.save(updated);
    return updated;
  }

  public list(filters: CardListFilters = {}): CloneCard[] {
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    assertPaginationInteger(limit, "limit", 1);
    assertPaginationInteger(offset, "offset", 0);

    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (filters.domain !== undefined) {
      clauses.push("domain = ?");
      parameters.push(domainSchema.parse(filters.domain));
    }
    if (filters.visibility !== undefined) {
      clauses.push("visibility = ?");
      parameters.push(visibilitySchema.parse(filters.visibility));
    }
    if (!filters.includeSuperseded) clauses.push("superseded_by IS NULL");
    if (filters.tag !== undefined) {
      const tag = filters.tag.trim();
      if (tag === "") throw new Error("tag must not be empty");
      clauses.push("EXISTS (SELECT 1 FROM json_each(clone_cards.tags) WHERE value = ?)");
      parameters.push(tag);
    }
    if (filters.query !== undefined) {
      const query = filters.query.trim();
      if (query === "") throw new Error("query must not be empty");
      clauses.push("(situation LIKE ? OR judgment LIKE ? OR rationale LIKE ?)");
      const like = `%${query}%`;
      parameters.push(like, like, like);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    parameters.push(limit, offset);
    const rows = this.#database
      .prepare<unknown[], CloneCardRow>(
        `SELECT ${CLONE_CARD_COLUMNS}
         FROM clone_cards ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters);
    return rows.map(mapCloneCardRow);
  }

  public listPageAfterId(afterId: string | null, limit: number): CloneCard[] {
    assertPaginationInteger(limit, "limit", 1);
    const rows =
      afterId === null
        ? this.#database
            .prepare<[number], CloneCardRow>(
              `SELECT ${CLONE_CARD_COLUMNS}
               FROM clone_cards ORDER BY id ASC LIMIT ?`,
            )
            .all(limit)
        : this.#database
            .prepare<[string, number], CloneCardRow>(
              `SELECT ${CLONE_CARD_COLUMNS}
               FROM clone_cards WHERE id > ? ORDER BY id ASC LIMIT ?`,
            )
            .all(afterId, limit);
    return rows.map(mapCloneCardRow);
  }

  public count(options: CardCountOptions = {}): number {
    const where = options.includeSuperseded ? "" : " WHERE superseded_by IS NULL";
    const row = this.#database
      .prepare<[], { count: number }>(`SELECT count(*) AS count FROM clone_cards${where}`)
      .get();
    if (row === undefined) throw new Error("Card count query returned no row");
    return row.count;
  }

  #assertSupersedeChain(cardId: string, replacementId: string | null): void {
    let nextId = replacementId;
    const visited = new Set<string>();
    while (nextId !== null) {
      if (nextId === cardId) {
        throw new Error(`supersededBy would create a cycle for card ${cardId}`);
      }
      if (visited.has(nextId)) {
        throw new Error(`supersededBy chain already contains a cycle at card ${nextId}`);
      }
      visited.add(nextId);
      const replacement = this.getById(nextId);
      if (replacement === null) {
        throw new Error(`Superseding card not found: ${nextId}`);
      }
      nextId = replacement.supersededBy;
    }
  }
}
