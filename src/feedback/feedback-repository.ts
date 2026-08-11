import { ulid } from "ulid";
import type { GeniusDatabase } from "../db/database.js";
import {
  cardFeedbackRatingSchema,
  EMPTY_CARD_FEEDBACK_SUMMARY,
  type CardFeedbackEntry,
  type CardFeedbackSummary,
  type RecordCardFeedbackInput,
} from "../domain/feedback.js";

interface FeedbackRow {
  id: string;
  card_id: string;
  rating: string;
  query_id: string | null;
  source: string | null;
  note: string | null;
  created_at: number;
}

interface SummaryRow {
  card_id: string;
  rating: string;
  count: number;
}

interface TimestampFloorRow {
  timestamp_floor: number;
}

function mapRow(row: FeedbackRow): CardFeedbackEntry {
  return {
    id: row.id,
    cardId: row.card_id,
    rating: cardFeedbackRatingSchema.parse(row.rating),
    queryId: row.query_id,
    source: row.source,
    note: row.note,
    createdAt: row.created_at,
  };
}

function addToSummary(summary: CardFeedbackSummary, rating: string, count: number): void {
  switch (cardFeedbackRatingSchema.parse(rating)) {
    case "great":
      summary.great += count;
      break;
    case "good":
      summary.good += count;
      break;
    case "poor":
      summary.poor += count;
      break;
    case "not-in-case":
      summary.notInCase += count;
      break;
  }
}

/**
 * `card_feedback` の永続化 (spec/feature/card-feedback.md §3)。
 *
 * アーカイブ判定そのものは持たない (archive-policy.ts)。ここは記録と集計だけ。
 */
export class CardFeedbackRepository {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;
  readonly #idFactory: () => string;

  constructor(
    database: GeniusDatabase,
    options: { clock?: () => number; idFactory?: () => string } = {},
  ) {
    this.#database = database;
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory ?? ulid;
  }

  record(cardId: string, input: RecordCardFeedbackInput): CardFeedbackEntry {
    // created_at は再有効化の境界にも使うため、同じ millisecond に複数操作が
    // 起きても対象カード内では必ず単調増加させる。
    const floor = this.#database
      .prepare<[string, string], TimestampFloorRow>(
        `SELECT MAX(
                  COALESCE(feedback_reset_at, 0),
                  COALESCE((SELECT MAX(created_at) FROM card_feedback WHERE card_id = ?), 0)
                ) AS timestamp_floor
           FROM clone_cards WHERE id = ?`,
      )
      .get(cardId, cardId)?.timestamp_floor ?? 0;
    const entry: CardFeedbackEntry = {
      id: this.#idFactory(),
      cardId,
      rating: cardFeedbackRatingSchema.parse(input.rating),
      queryId: input.queryId ?? null,
      source: input.source ?? null,
      note: input.note ?? null,
      createdAt: Math.max(this.#clock(), floor + 1),
    };
    this.#database
      .prepare(
        `INSERT INTO card_feedback(id, card_id, rating, query_id, source, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.cardId,
        entry.rating,
        entry.queryId,
        entry.source,
        entry.note,
        entry.createdAt,
      );
    return entry;
  }

  /**
   * 1 枚分の集計。`since` を渡すとそれより新しい評価だけを数える
   * (un-retire 後の再アーカイブ抑止、§4)。
   */
  summary(cardId: string, since: number | null = null): CardFeedbackSummary {
    const rows = this.#database
      .prepare<[string, number], SummaryRow>(
        `SELECT card_id, rating, COUNT(*) AS count
           FROM card_feedback
          WHERE card_id = ? AND created_at > ?
          GROUP BY rating`,
      )
      .all(cardId, since ?? 0);
    const summary = { ...EMPTY_CARD_FEEDBACK_SUMMARY };
    for (const row of rows) addToSummary(summary, row.rating, row.count);
    return summary;
  }

  /**
   * 複数カードの集計を 1 本のクエリで引く。一覧表示がカード 1 枚ごとに
   * 問い合わせるのを防ぐ (§6)。集計はここでも全期間 (表示は抑止時刻に依らない)。
   */
  summaries(cardIds: readonly string[]): Map<string, CardFeedbackSummary> {
    const result = new Map<string, CardFeedbackSummary>();
    if (cardIds.length === 0) return result;
    const placeholders = cardIds.map(() => "?").join(", ");
    const rows = this.#database
      .prepare<string[], SummaryRow>(
        `SELECT card_id, rating, COUNT(*) AS count
           FROM card_feedback
          WHERE card_id IN (${placeholders})
          GROUP BY card_id, rating`,
      )
      .all(...cardIds);
    for (const row of rows) {
      const summary = result.get(row.card_id) ?? { ...EMPTY_CARD_FEEDBACK_SUMMARY };
      addToSummary(summary, row.rating, row.count);
      result.set(row.card_id, summary);
    }
    return result;
  }

  /** 直近の評価。note を含むので loopback の閲覧経路からのみ使う。 */
  recent(cardId: string, limit = 20): CardFeedbackEntry[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("card feedback list limit must be a positive integer");
    }
    return this.#database
      .prepare<[string, number], FeedbackRow>(
        `SELECT * FROM card_feedback
          WHERE card_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(cardId, limit)
      .map(mapRow);
  }
}
