import { z } from "zod";

/**
 * カード評価の統制語彙 (spec/feature/card-feedback.md §2)。
 *
 * `not-in-case` だけは意味が違う: 「カードが悪い」ではなく「この場面には当てはまらない」
 * = 検索側の外し。アーカイブ判定 (§4) では分子にも分母にも入れない。
 * ここを混ぜると、汎用的で正しいカードが「場面違いで引かれた回数」だけで消える。
 */
export const CARD_FEEDBACK_RATINGS = ["great", "good", "poor", "not-in-case"] as const;

export const cardFeedbackRatingSchema = z.enum(CARD_FEEDBACK_RATINGS);

export type CardFeedbackRating = z.infer<typeof cardFeedbackRatingSchema>;

export const MAX_FEEDBACK_NOTE_LENGTH = 4_096;
export const MAX_FEEDBACK_SOURCE_LENGTH = 256;

export const cardFeedbackNoteSchema = z.string().trim().min(1).max(MAX_FEEDBACK_NOTE_LENGTH);
export const cardFeedbackSourceSchema = z.string().trim().min(1).max(MAX_FEEDBACK_SOURCE_LENGTH);

/** 1 件の評価。`note` は自由文なので公開 export とカード DTO には出さない。 */
export interface CardFeedbackEntry {
  id: string;
  cardId: string;
  rating: CardFeedbackRating;
  queryId: string | null;
  source: string | null;
  note: string | null;
  createdAt: number;
}

export interface RecordCardFeedbackInput {
  rating: CardFeedbackRating;
  queryId?: string | null;
  source?: string | null;
  note?: string | null;
}

/** 評価の件数だけを持つ集計。カード DTO へ載せてよいのはこの形だけ。 */
export interface CardFeedbackSummary {
  great: number;
  good: number;
  poor: number;
  notInCase: number;
}

export const EMPTY_CARD_FEEDBACK_SUMMARY: CardFeedbackSummary = {
  great: 0,
  good: 0,
  poor: 0,
  notInCase: 0,
};

/**
 * 品質として評価された件数 (`not-in-case` を除く)。アーカイブ判定の分母。
 */
export function judgedFeedbackCount(summary: CardFeedbackSummary): number {
  return summary.great + summary.good + summary.poor;
}
