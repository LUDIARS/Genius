import { CardRevisionRepository } from "../cards/card-revision-repository.js";
import type { GeniusDatabase } from "../db/database.js";
import type { CloneCard } from "../domain/card.js";
import type {
  CardFeedbackEntry,
  CardFeedbackSummary,
  RecordCardFeedbackInput,
} from "../domain/feedback.js";
import {
  DEFAULT_ARCHIVE_THRESHOLDS,
  shouldArchive,
  type ArchiveThresholds,
} from "./archive-policy.js";
import type { CardFeedbackRepository } from "./feedback-repository.js";

/** 存在しないカードへの評価は 404 にしたいので、他の失敗と型で分ける。 */
export class CardNotFoundError extends Error {
  constructor(cardId: string) {
    super(`Card not found: ${cardId}`);
    this.name = "CardNotFoundError";
  }
}

/** 見えないはずのカードへ評価が飛んできたときの拒否 (MCP 経路)。 */
export class CardFeedbackNotAllowedError extends Error {
  constructor(cardId: string) {
    super(`Card is not visible to this caller: ${cardId}`);
    this.name = "CardFeedbackNotAllowedError";
  }
}

export interface CardFeedbackCardsPort {
  getById(id: string): CloneCard | null;
  archiveByFeedback(id: string): boolean;
  feedbackResetAt(id: string): number | null;
  isArchivedByFeedback(id: string): boolean;
}

export interface RecordFeedbackOptions {
  /** MCP のように public しか見せていない経路はこれを立てる。 */
  publicOnly?: boolean;
}

export interface RecordFeedbackResult {
  entry: CardFeedbackEntry;
  summary: CardFeedbackSummary;
  /** この評価でアーカイブされたか。既にアーカイブ済みなら false。 */
  archived: boolean;
}

export interface CardFeedbackServiceOptions {
  database: GeniusDatabase;
  cards: CardFeedbackCardsPort;
  feedback: CardFeedbackRepository;
  thresholds?: ArchiveThresholds;
}

/**
 * 評価の記録とアーカイブ判定の接続点 (spec/feature/card-feedback.md §4)。
 *
 * 規則そのものは archive-policy.ts、永続化は feedback-repository.ts が持つ。
 * ここは「記録する → 抑止時刻以降の集計を取る → 規則にかける → 落とす」だけ。
 */
export class CardFeedbackService {
  readonly #database: GeniusDatabase;
  readonly #cards: CardFeedbackCardsPort;
  readonly #feedback: CardFeedbackRepository;
  readonly #revisions: CardRevisionRepository;
  readonly #thresholds: ArchiveThresholds;

  constructor(options: CardFeedbackServiceOptions) {
    this.#database = options.database;
    this.#cards = options.cards;
    this.#feedback = options.feedback;
    this.#revisions = new CardRevisionRepository(options.database);
    this.#thresholds = options.thresholds ?? DEFAULT_ARCHIVE_THRESHOLDS;
  }

  record(
    cardId: string,
    input: RecordCardFeedbackInput,
    options: RecordFeedbackOptions = {},
  ): RecordFeedbackResult {
    return this.#database.transaction(() => {
      const card = this.#cards.getById(cardId);
      if (card === null) throw new CardNotFoundError(cardId);
      // MCP は public カードしか返さない。そこへ sensitive の id が来たということは
      // 呼び出し側が別経路の id を持ち込んでいるので、黙って受けずに拒否する。
      if ((options.publicOnly ?? false) && card.visibility !== "public") {
        throw new CardFeedbackNotAllowedError(cardId);
      }

      const entry = this.#feedback.record(cardId, input);
      // 表示用の集計は全期間。アーカイブ判定だけが抑止時刻以降に絞られる。
      const summary = this.#feedback.summary(cardId);
      const since = this.#cards.feedbackResetAt(cardId);
      const judgingSummary = since === null ? summary : this.#feedback.summary(cardId, since);
      const archived =
        card.retiredAt === null && shouldArchive(judgingSummary, this.#thresholds)
          ? this.#cards.archiveByFeedback(cardId)
          : false;
      if (archived) {
        this.#revisions.record(cardId, ["retired_at", "retired_reason"], "api");
      }
      return { entry, summary, archived };
    }).immediate();
  }

  summary(cardId: string): CardFeedbackSummary {
    if (this.#cards.getById(cardId) === null) throw new CardNotFoundError(cardId);
    return this.#feedback.summary(cardId);
  }

  summaries(cardIds: readonly string[]): Map<string, CardFeedbackSummary> {
    return this.#feedback.summaries(cardIds);
  }

  recent(cardId: string, limit?: number): CardFeedbackEntry[] {
    if (this.#cards.getById(cardId) === null) throw new CardNotFoundError(cardId);
    return this.#feedback.recent(cardId, limit);
  }

  isArchivedByFeedback(cardId: string): boolean {
    if (this.#cards.getById(cardId) === null) throw new CardNotFoundError(cardId);
    return this.#cards.isArchivedByFeedback(cardId);
  }
}
