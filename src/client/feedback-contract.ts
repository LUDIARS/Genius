import { z } from "zod";
import {
  cardFeedbackNoteSchema,
  cardFeedbackRatingSchema,
  cardFeedbackSourceSchema,
} from "../domain/feedback.js";

/**
 * 利用側 (MCP / 他サービス) が評価を返すときの入出力
 * (spec/feature/card-feedback.md §5)。
 *
 * サーバ側の route schema とは別物として置く: これは「外から見た約束」で、
 * 破ると利用側が壊れる。route の内部フィールドをそのまま外へ出さない。
 */
export const cardFeedbackInputSchema = z
  .object({
    cardId: z.string().trim().min(1).max(64),
    rating: cardFeedbackRatingSchema,
    /** `genius_query` の応答に紐づく query_log id があれば渡す。 */
    queryId: z.string().trim().min(1).max(64).optional(),
    /** 送信元 (サービスコードやセッション ID)。誰の評価かを後から辿るため。 */
    source: cardFeedbackSourceSchema.optional(),
    /** 自由文。何が外れていたかを一言で。 */
    note: cardFeedbackNoteSchema.optional(),
  })
  .strict();

export type CardFeedbackInput = z.infer<typeof cardFeedbackInputSchema>;

export const cardFeedbackSummarySchema = z
  .object({
    great: z.number().int().min(0),
    good: z.number().int().min(0),
    poor: z.number().int().min(0),
    notInCase: z.number().int().min(0),
  })
  .strict();

export const cardFeedbackResultSchema = z
  .object({
    id: z.string(),
    summary: cardFeedbackSummarySchema,
    /** この評価でカードがアーカイブされたか。 */
    archived: z.boolean(),
  })
  .strict();

export type CardFeedbackResult = z.infer<typeof cardFeedbackResultSchema>;

export interface SendCardFeedbackOptions {
  /**
   * public カードしか見せていない呼び出し元 (MCP) が立てる。sensitive の id を
   * 送っても 403 になる。loopback の CLI / WebUI は立てない。
   */
  publicOnly?: boolean;
}

export interface GeniusFeedbackService {
  sendCardFeedback(
    input: CardFeedbackInput,
    options?: SendCardFeedbackOptions,
  ): Promise<CardFeedbackResult>;
}
