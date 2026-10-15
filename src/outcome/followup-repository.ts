import { CLONE_CARD_COLUMNS, mapCloneCardRow, type CloneCardRow } from "../cards/card-row.js";
import { activeCardClause } from "../cards/active-card-sql.js";
import type { GeniusDatabase } from "../db/database.js";
import type { CloneCard } from "../domain/card.js";
import type { FollowupWindow } from "./followup-window.js";

export interface OutcomeFollowup {
  cardId: string;
  discordMessageId: string;
  askedAt: number;
  answeredAt: number | null;
}

interface FollowupRow {
  card_id: string;
  discord_message_id: string;
  asked_at: number;
  answered_at: number | null;
}

interface EarliestRow {
  earliest: number | null;
}

function mapRow(row: FollowupRow): OutcomeFollowup {
  return {
    cardId: row.card_id,
    discordMessageId: row.discord_message_id,
    askedAt: row.asked_at,
    answeredAt: row.answered_at,
  };
}

/**
 * 「結果は?」の配信記録 (`card_outcome_followups`、spec/feature/judgment-outcome.md §3)。
 */
export class OutcomeFollowupRepository {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;

  constructor(database: GeniusDatabase, options: { clock?: () => number } = {}) {
    this.#database = database;
    this.#clock = options.clock ?? Date.now;
  }

  /**
   * 訊く対象: active で、outcome が未記入で、まだ一度も訊いていないカード。
   * 古い判断から順に `limit` 枚。
   */
  listDue(window: FollowupWindow, limit: number): CloneCard[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("follow-up limit must be a positive integer");
    }
    return this.#database
      .prepare<[number, number, number], CloneCardRow>(
        `SELECT ${CLONE_CARD_COLUMNS}
           FROM clone_cards
          WHERE ${activeCardClause()}
            AND created_at BETWEEN ? AND ?
            AND id NOT IN (SELECT card_id FROM card_outcomes)
            AND id NOT IN (SELECT card_id FROM card_outcome_followups)
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .all(window.decidedFrom, window.decidedTo, limit)
      .map(mapCloneCardRow);
  }

  markAsked(cardId: string, discordMessageId: string): void {
    this.#database
      .prepare(
        `INSERT INTO card_outcome_followups(card_id, discord_message_id, asked_at, answered_at)
         VALUES (?, ?, ?, NULL)`,
      )
      .run(cardId, discordMessageId, this.#clock());
  }

  findByDiscordMessageId(discordMessageId: string): OutcomeFollowup | null {
    const row = this.#database
      .prepare<[string], FollowupRow>(
        "SELECT * FROM card_outcome_followups WHERE discord_message_id = ?",
      )
      .get(discordMessageId);
    return row === undefined ? null : mapRow(row);
  }

  markAnswered(cardId: string): void {
    this.#database
      .prepare(
        "UPDATE card_outcome_followups SET answered_at = ? WHERE card_id = ? AND answered_at IS NULL",
      )
      .run(this.#clock(), cardId);
  }

  /** 返信の取り込み開始位置 (未回答の最古の配信時刻)。カーソルを別に覚えない。 */
  earliestOutstandingAskedAt(): number | null {
    return this.#database
      .prepare<[], EarliestRow>(
        "SELECT MIN(asked_at) AS earliest FROM card_outcome_followups WHERE answered_at IS NULL",
      )
      .get()?.earliest ?? null;
  }
}
