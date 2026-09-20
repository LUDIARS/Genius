import { z } from "zod";
import type { Classifier, Disclosure } from "../classify/classifier.js";
import type { GeniusDatabase } from "../db/database.js";
import type { CloneCard } from "../domain/card.js";
import { FALLBACK_CATEGORY } from "../domain/category.js";
import type { EmbeddingClient } from "../embedding/types.js";
import { encodeVector } from "../embedding/vector-codec.js";
import { GapRepository, publicCardEvidence } from "./gap-repository.js";
import { QuestionRepository } from "./question-repository.js";
import { canonicalCardPairId, type ContradictionPair, type GapEvidence } from "./types.js";

const EMBEDDING_BATCH_SIZE = 64;
const NEIGHBOR_COUNT = 5;
const NEIGHBOR_PREFETCH = 20;
/** clone_vec (migration 001) と同じく 1024 次元固定 (config の embedding.dim も literal 1024)。 */
const SITUATION_INDEX_DIMENSION = 1024;

const CONTRADICTION_INSTRUCTIONS =
  "Decide whether two judgment cards give mutually incompatible instructions for the same situation. " +
  "Different aspects or compatible tradeoffs are not contradictions.";
const CONTRADICTION_CRITERIA = {
  true: "The two cards cannot both be followed in the same situation.",
  false: "The two cards address different aspects, or describe a compatible tradeoff.",
} as const;

const QUADRANT_TABLES = {
  "work:public": "temp.question_situation_work_public",
  "work:sensitive": "temp.question_situation_work_sensitive",
  "hobby:public": "temp.question_situation_hobby_public",
  "hobby:sensitive": "temp.question_situation_hobby_sensitive",
} as const;

interface VecMatchRow {
  card_id: string;
  distance: number;
}

export interface ContradictionDetectorOptions {
  database: GeniusDatabase;
  embedder: EmbeddingClient;
  gaps: GapRepository;
  classifier: Classifier;
  questions: QuestionRepository;
  situationSimilarityMin: number;
  judgmentSimilarityMax: number;
  /** 矛盾と判定する確率の下限 (config.classifier.contradictionThreshold)。 */
  contradictionThreshold: number;
  warningSink?: (message: string) => void;
}

/**
 * Detects true same-quadrant contradictions without persisting a second card
 * index (spec/feature/active-questioning.md §1.1). situation 単独の埋め込みは
 * 検出 run 中だけ temp vec table に載せ、永続 index を二重化しない。
 */
export class ContradictionDetector {
  readonly #database: GeniusDatabase;
  readonly #embedder: EmbeddingClient;
  readonly #gaps: GapRepository;
  readonly #classifier: Classifier;
  readonly #questions: QuestionRepository;
  readonly #situationSimilarityMin: number;
  readonly #judgmentSimilarityMax: number;
  readonly #contradictionThreshold: number;
  readonly #warningSink: (message: string) => void;
  #running = false;

  constructor(options: ContradictionDetectorOptions) {
    assertSimilarity(options.situationSimilarityMin, "situationSimilarityMin");
    assertSimilarity(options.judgmentSimilarityMax, "judgmentSimilarityMax");
    if (options.embedder.dimension !== SITUATION_INDEX_DIMENSION) {
      throw new Error(
        `Contradiction temporary vec tables require ${SITUATION_INDEX_DIMENSION}-dimensional embeddings`,
      );
    }
    this.#database = options.database;
    this.#embedder = options.embedder;
    this.#gaps = options.gaps;
    this.#classifier = options.classifier;
    this.#questions = options.questions;
    this.#situationSimilarityMin = options.situationSimilarityMin;
    this.#judgmentSimilarityMax = options.judgmentSimilarityMax;
    this.#contradictionThreshold = options.contradictionThreshold;
    this.#warningSink = options.warningSink ?? ((message) => process.stderr.write(`${message}\n`));
  }

  async detect(limit: number): Promise<GapEvidence[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    if (this.#running) throw new Error("Contradiction detection is already running");
    this.#running = true;
    try {
      const cards = this.#gaps.listActiveCards();
      if (cards.length < 2) return [];
      const situationVectors = await embedByCard(this.#embedder, cards, (card) => card.situation);
      this.#replaceTemporarySituationIndex(cards, situationVectors);
      const approximatePairs = this.#nearestPairs(cards, situationVectors);
      if (approximatePairs.length === 0) return [];

      const judgmentCards = uniqueCards(approximatePairs.flatMap((pair) => [pair.left, pair.right]));
      const judgmentVectors = await embedByCard(
        this.#embedder,
        judgmentCards,
        (card) => card.judgment,
      );
      const candidates = approximatePairs
        .map((pair) => ({
          ...pair,
          judgmentSimilarity: cosine(
            requireVector(judgmentVectors, pair.left.id),
            requireVector(judgmentVectors, pair.right.id),
          ),
        }))
        .filter((pair) => pair.judgmentSimilarity <= this.#judgmentSimilarityMax)
        .sort((left, right) =>
          right.situationSimilarity - left.situationSimilarity
          || left.judgmentSimilarity - right.judgmentSimilarity
          || canonicalCardPairId(left.left.id, left.right.id)
            .localeCompare(canonicalCardPairId(right.left.id, right.right.id)),
        );

      const results: GapEvidence[] = [];
      for (const pair of candidates) {
        if (results.length >= limit) break;
        const pairId = canonicalCardPairId(pair.left.id, pair.right.id);
        if (this.#questions.hasTarget({ kind: "card-pair", id: pairId })) continue;
        if (!(await this.#isTrueContradiction(pair))) continue;
        results.push(toGap(pair, pairId));
      }
      return results;
    } finally {
      this.#running = false;
    }
  }

  #replaceTemporarySituationIndex(
    cards: readonly CloneCard[],
    vectors: ReadonlyMap<string, readonly number[]>,
  ): void {
    for (const table of Object.values(QUADRANT_TABLES)) {
      this.#database.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
           card_id TEXT PRIMARY KEY, embedding float[${SITUATION_INDEX_DIMENSION}]
         ); DELETE FROM ${table};`,
      );
    }
    this.#database.transaction(() => {
      for (const card of cards) {
        const table = tableFor(card);
        this.#database
          .prepare(`INSERT INTO ${table}(card_id, embedding) VALUES (?, ?)`)
          .run(
            card.id,
            encodeVector(requireVector(vectors, card.id), SITUATION_INDEX_DIMENSION),
          );
      }
    })();
  }

  #nearestPairs(
    cards: readonly CloneCard[],
    vectors: ReadonlyMap<string, readonly number[]>,
  ): Array<Omit<ContradictionPair, "judgmentSimilarity">> {
    const cardsById = new Map(cards.map((card) => [card.id, card]));
    const quadrantCounts = new Map<string, number>();
    for (const card of cards) {
      const table = tableFor(card);
      quadrantCounts.set(table, (quadrantCounts.get(table) ?? 0) + 1);
    }
    const pairs = new Map<string, Omit<ContradictionPair, "judgmentSimilarity">>();
    for (const card of cards) {
      const table = tableFor(card);
      const count = quadrantCounts.get(table) ?? 0;
      if (count < 2) continue;
      const rows = this.#database
        .prepare<[Buffer, number], VecMatchRow>(
          `SELECT card_id, distance FROM ${table}
            WHERE embedding MATCH ? AND k = ? ORDER BY distance ASC`,
        )
        .all(
          encodeVector(requireVector(vectors, card.id), SITUATION_INDEX_DIMENSION),
          Math.min(count, NEIGHBOR_PREFETCH + 1),
        );
      const exact = rows
        .filter((row) => row.card_id !== card.id)
        .map((row) => ({
          card: cardsById.get(row.card_id),
          similarity: cosine(
            requireVector(vectors, card.id),
            requireVector(vectors, row.card_id),
          ),
        }))
        .filter((entry): entry is { card: CloneCard; similarity: number } => entry.card !== undefined)
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, NEIGHBOR_COUNT);
      for (const neighbor of exact) {
        if (neighbor.similarity < this.#situationSimilarityMin) continue;
        const id = canonicalCardPairId(card.id, neighbor.card.id);
        const [left, right] = card.id < neighbor.card.id
          ? [card, neighbor.card]
          : [neighbor.card, card];
        const existing = pairs.get(id);
        if (!existing || neighbor.similarity > existing.situationSimilarity) {
          pairs.set(id, { left, right, situationSimilarity: neighbor.similarity });
        }
      }
    }
    return [...pairs.values()];
  }

  async #isTrueContradiction(pair: ContradictionPair): Promise<boolean> {
    try {
      const result = await this.#classifier.noul({
        purpose: "contradiction-check",
        instructions: CONTRADICTION_INSTRUCTIONS,
        criteria: CONTRADICTION_CRITERIA,
        evidence: {
          left: publicCardEvidence(pair.left),
          right: publicCardEvidence(pair.right),
          situationSimilarity: pair.situationSimilarity,
          judgmentSimilarity: pair.judgmentSimilarity,
        },
        // publicCardEvidence はフィールドの射影であって sensitive カードを
        // 除外しない。外の判定バックエンドへ出せるのは両方が public のときだけ。
        disclosure: pairDisclosure(pair),
        threshold: this.#contradictionThreshold,
      });
      return result.yes;
    } catch {
      this.#warningSink("[questions] contradiction LLM check failed; candidate skipped");
      return false;
    }
  }
}

/**
 * 対の両方が public のときだけ、このマシンの外の判定バックエンドへ出せる。
 * 片方でも sensitive ならローカル判定に閉じる。
 */
function pairDisclosure(pair: ContradictionPair): Disclosure {
  return pair.left.visibility === "public" && pair.right.visibility === "public"
    ? "public"
    : "local-only";
}

async function embedByCard(
  embedder: EmbeddingClient,
  cards: readonly CloneCard[],
  text: (card: CloneCard) => string,
): Promise<Map<string, readonly number[]>> {
  const result = new Map<string, readonly number[]>();
  for (let start = 0; start < cards.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = cards.slice(start, start + EMBEDDING_BATCH_SIZE);
    const vectors = await embedder.embed(batch.map(text));
    if (vectors.length !== batch.length) throw new Error("Contradiction embedder returned wrong count");
    for (let index = 0; index < batch.length; index += 1) {
      const card = batch[index];
      const vector = vectors[index];
      if (!card || !vector) throw new Error("Contradiction embedder omitted a vector");
      result.set(card.id, vector);
    }
  }
  return result;
}

function uniqueCards(cards: readonly CloneCard[]): CloneCard[] {
  return [...new Map(cards.map((card) => [card.id, card])).values()];
}

function requireVector(
  vectors: ReadonlyMap<string, readonly number[]>,
  cardId: string,
): readonly number[] {
  const vector = vectors.get(cardId);
  if (!vector) throw new Error(`Missing temporary embedding for card ${cardId}`);
  return vector;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) throw new Error("Cosine vectors mismatch");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function tableFor(card: Pick<CloneCard, "domain" | "visibility">): string {
  return QUADRANT_TABLES[`${card.domain}:${card.visibility}`];
}

function toGap(pair: ContradictionPair, pairId: string): GapEvidence {
  const category = pair.left.category !== null && pair.left.category === pair.right.category
    ? pair.left.category
    : FALLBACK_CATEGORY;
  return {
    gapKind: "contradiction",
    domain: pair.left.domain,
    visibility:
      pair.left.visibility === "sensitive" || pair.right.visibility === "sensitive"
        ? "sensitive"
        : "public",
    category,
    primaryTarget: { kind: "card-pair", id: pairId },
    targets: [
      { kind: "card-pair", id: pairId },
      { kind: "card-context", id: pair.left.id },
      { kind: "card-context", id: pair.right.id },
    ],
    promptEvidence: {
      left: publicCardEvidence(pair.left),
      right: publicCardEvidence(pair.right),
      situationSimilarity: pair.situationSimilarity,
      judgmentSimilarity: pair.judgmentSimilarity,
    },
  };
}

function assertSimilarity(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
}
