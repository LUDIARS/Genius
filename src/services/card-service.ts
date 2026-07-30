import { ulid } from "ulid";
import type { ListCardsInput, ManualCardInput } from "../api/contracts.js";
import { CardRepository } from "../cards/card-repository.js";
import {
  CardRevisionRepository,
  type CardRevision,
} from "../cards/card-revision-repository.js";
import {
  cardEmbeddingText,
  type CardChangeOrigin,
  type CardPatch,
  type CloneCard,
  type CreateCardInput,
} from "../domain/card.js";
import type { PublicCardGate } from "../distill/public-card-gate.js";
import type { GeniusDatabase } from "../db/database.js";
import type { EmbeddingClient } from "../embedding/types.js";
import { VectorStore } from "../embedding/vector-store.js";

interface IdRow {
  id: string;
}

/**
 * Raised when a sensitive→public promotion is re-checked by the public card
 * gate and the gate still classifies the content as sensitive. The promotion
 * is rejected outright instead of being silently downgraded, so the caller
 * cannot mistake the card for published (spec/feature/operations.md Section 2).
 */
export class CardPromotionRejectedError extends Error {
  constructor(cardId: string) {
    super(`Card ${cardId} cannot be promoted to public: the sensitive check rejected it`);
    this.name = "CardPromotionRejectedError";
  }
}

/** clone_cards columns whose PATCH changes are recorded as a revision. */
const REVISION_TRACKED_COLUMNS = ["domain", "visibility", "category"] as const;

export class CardService {
  readonly #database: GeniusDatabase;
  readonly #cards: CardRepository;
  readonly #embedder: EmbeddingClient;
  readonly #revisions: CardRevisionRepository;
  readonly #vectors: VectorStore;
  readonly #publicCardGate: PublicCardGate;

  constructor(
    database: GeniusDatabase,
    cards: CardRepository,
    embedder: EmbeddingClient,
    vectors: VectorStore,
    publicCardGate: PublicCardGate,
  ) {
    this.#database = database;
    this.#cards = cards;
    this.#embedder = embedder;
    this.#revisions = new CardRevisionRepository(database);
    this.#vectors = vectors;
    this.#publicCardGate = publicCardGate;
  }

  async list(input: ListCardsInput): Promise<CloneCard[]> {
    return this.#cards.list({
      ...(input.domain === undefined ? {} : { domain: input.domain }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.tag === undefined ? {} : { tag: input.tag }),
      ...(input.q === undefined ? {} : { query: input.q }),
      limit: input.limit,
      offset: input.offset,
    });
  }

  async get(id: string): Promise<CloneCard | null> {
    return this.#cards.getById(id);
  }

  async create(input: ManualCardInput): Promise<CloneCard> {
    return this.saveWithEmbedding({
      ...input,
      sourceRef: input.sourceRef ?? `manual:${ulid()}`,
      sourceTier: input.sourceTier ?? 1,
    });
  }

  async saveWithEmbedding(input: CreateCardInput): Promise<CloneCard> {
    const existing = this.#findBySourceRef(input.sourceRef);
    if (existing) return existing;
    const checked = await this.#publicCardGate.check(input);
    return this.saveCheckedWithEmbedding({ ...input, ...checked });
  }

  /** Persist only after the shared PublicCardGate has evaluated this exact card content. */
  async saveCheckedWithEmbedding(input: CreateCardInput): Promise<CloneCard> {
    const existing = this.#findBySourceRef(input.sourceRef);
    if (existing) return existing;
    const card = this.#cards.prepareCreate(input);
    const [vector] = await this.#embedder.embed([cardEmbeddingText(card)]);
    if (!vector) throw new Error("Card embedder returned no vector");
    return this.#database.transaction(() => {
      const concurrent = this.#findBySourceRef(input.sourceRef);
      if (concurrent) return concurrent;
      this.#cards.insert(card);
      this.#vectors.insert(card.id, vector);
      return card;
    }).immediate();
  }

  /** Atomically persist a checked replacement and retire the previous active card. */
  async replaceCheckedWithEmbedding(
    input: CreateCardInput,
    supersededCardId: string,
  ): Promise<CloneCard> {
    this.#cards.requireById(supersededCardId);
    const existing = this.#findBySourceRef(input.sourceRef);
    if (existing) {
      if (existing.id !== supersededCardId) {
        this.#linkSuperseded(supersededCardId, existing.id);
      }
      return existing;
    }
    const card = this.#cards.prepareCreate(input);
    const [vector] = await this.#embedder.embed([cardEmbeddingText(card)]);
    if (!vector) throw new Error("Card embedder returned no vector");
    return this.#database.transaction(() => {
      const concurrent = this.#findBySourceRef(input.sourceRef);
      if (concurrent) {
        if (concurrent.id !== supersededCardId) {
          this.#linkSuperseded(supersededCardId, concurrent.id);
        }
        return concurrent;
      }
      this.#cards.insert(card);
      this.#vectors.insert(card.id, vector);
      this.#linkSuperseded(supersededCardId, card.id);
      return card;
    }).immediate();
  }

  async patch(
    id: string,
    patch: CardPatch,
    changedBy: CardChangeOrigin,
  ): Promise<CloneCard | null> {
    const current = this.#cards.getById(id);
    if (!current) return null;
    const requested = this.#cards.preparePatch(current, patch);
    const isPromotion =
      current.visibility === "sensitive" && requested.visibility === "public";
    const shouldCheckPublic =
      requested.visibility === "public" &&
      (isPromotion ||
        patch.situation !== undefined ||
        patch.judgment !== undefined ||
        patch.rationale !== undefined ||
        patch.tags !== undefined);
    const checked = shouldCheckPublic ? await this.#publicCardGate.check(requested) : requested;
    // A promotion the gate flags is rejected, never silently downgraded.
    // Demotions (public→sensitive) skip the gate and are always allowed.
    if (isPromotion && checked.visibility !== "public") {
      throw new CardPromotionRejectedError(id);
    }
    const updated = { ...requested, ...checked };
    const shouldReembed =
      patch.situation !== undefined ||
      patch.judgment !== undefined ||
      patch.rationale !== undefined ||
      patch.domain !== undefined ||
      patch.visibility !== undefined ||
      updated.visibility !== current.visibility;
    const vector = shouldReembed
      ? (await this.#embedder.embed([cardEmbeddingText(updated)]))[0]
      : undefined;
    if (shouldReembed && !vector) throw new Error("Card embedder returned no vector for patch");
    const changedFields = changedCardColumns(current, updated);
    const shouldRecordRevision = REVISION_TRACKED_COLUMNS.some((column) =>
      changedFields.includes(column));
    this.#database.transaction(() => {
      this.#cards.save(updated);
      if (vector) this.#vectors.upsert(updated.id, vector);
      if (shouldRecordRevision) this.#revisions.record(id, changedFields, changedBy);
    })();
    return updated;
  }

  markSuperseded(cardId: string, replacementId: string): void {
    this.#database.transaction(() => {
      this.#linkSuperseded(cardId, replacementId);
    }).immediate();
  }

  count(): number {
    return this.#cards.count();
  }

  #findBySourceRef(sourceRef: string): CloneCard | null {
    const row = this.#database
      .prepare<[string], IdRow>(
        "SELECT id FROM clone_cards WHERE source_ref = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(sourceRef);
    return row ? this.#cards.requireById(row.id) : null;
  }

  listRevisions(cardId: string): CardRevision[] {
    return this.#revisions.listByCard(cardId);
  }

  #linkSuperseded(cardId: string, replacementId: string): void {
    const replacement = this.#cards.getById(replacementId);
    if (!replacement) throw new Error(`Replacement card not found: ${replacementId}`);
    const current = this.#cards.requireById(cardId);
    if (current.supersededBy === replacementId) return;
    if (current.supersededBy !== null) {
      throw new Error(
        `Card ${cardId} is already superseded by ${current.supersededBy}`,
      );
    }
    this.#cards.update(cardId, { supersededBy: replacementId });
  }
}

/**
 * Returns the clone_cards column names whose values differ between two card
 * states. Only names are returned — the revision trail must never carry card
 * content (spec/feature/operations.md Section 2).
 */
function changedCardColumns(before: CloneCard, after: CloneCard): string[] {
  const changed: string[] = [];
  if (before.domain !== after.domain) changed.push("domain");
  if (before.visibility !== after.visibility) changed.push("visibility");
  if (before.category !== after.category) changed.push("category");
  if (before.situation !== after.situation) changed.push("situation");
  if (before.judgment !== after.judgment) changed.push("judgment");
  if (before.rationale !== after.rationale) changed.push("rationale");
  if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) changed.push("tags");
  if (before.confidence !== after.confidence) changed.push("confidence");
  if (before.supersededBy !== after.supersededBy) changed.push("superseded_by");
  return changed;
}
