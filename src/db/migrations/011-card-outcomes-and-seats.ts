import { MAX_DECISION_AUTHOR_LENGTH } from "../../domain/card.js";
import {
  MAX_OUTCOME_TEXT_LENGTH,
  OUTCOME_RECORDED_VIA,
  OUTCOME_VERDICTS,
} from "../../domain/outcome.js";
import { JUDGMENT_SEATS, SEAT_PROPOSAL_STATUSES } from "../../domain/seat.js";
import type { Migration } from "./types.js";

// 統制語彙は domain/ が正本。CHECK 制約へベタ書きすると二重定義になる (008 と同じ方針)。
const inList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(", ");

const VERDICTS = inList(OUTCOME_VERDICTS);
const RECORDED_VIA = inList(OUTCOME_RECORDED_VIA);
const SEATS = inList(JUDGMENT_SEATS);
const PROPOSAL_STATUSES = inList(SEAT_PROPOSAL_STATUSES);
// decided_by / answered_by と同じ上限 (decisionAuthorSchema と対)。
const AUTHOR_MAX = MAX_DECISION_AUTHOR_LENGTH;

/**
 * 判断の outcome 記録と席タグ (spec/feature/judgment-outcome.md、MUSA バックログ S1)。
 *
 * すべて別テーブルで持ち、clone_cards には列を足さない:
 * - outcome は判断者が後日書く「結果」で、カード本文ではない。カードの再埋め込み・
 *   supersede・公開 export の対象にしない。
 * - 行が無いカード = 既存カード・未記入。読み手は null として扱う (backfill しない)。
 */
export const cardOutcomesAndSeatsMigration: Migration = {
  version: 11,
  name: "card outcomes, outcome follow-ups and judgment seats",
  /** @implements SPEC-GENIUS-OUTCOME-RECORD */
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS card_outcomes (
        card_id          TEXT PRIMARY KEY REFERENCES clone_cards(id) ON DELETE CASCADE,
        adopted_decision TEXT NOT NULL CHECK (
          length(adopted_decision) BETWEEN 1 AND ${MAX_OUTCOME_TEXT_LENGTH}
        ),
        actual_result    TEXT NOT NULL CHECK (
          length(actual_result) BETWEEN 1 AND ${MAX_OUTCOME_TEXT_LENGTH}
        ),
        verdict          TEXT NOT NULL CHECK (verdict IN (${VERDICTS})),
        recorded_by      TEXT NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND ${AUTHOR_MAX}),
        recorded_via     TEXT NOT NULL CHECK (recorded_via IN (${RECORDED_VIA})),
        recorded_at      INTEGER NOT NULL
      );

      -- 「結果は?」の配信記録 (§3)。1 枚につき 1 回しか訊かない。
      CREATE TABLE IF NOT EXISTS card_outcome_followups (
        card_id            TEXT PRIMARY KEY REFERENCES clone_cards(id) ON DELETE CASCADE,
        discord_message_id TEXT NOT NULL UNIQUE CHECK (length(discord_message_id) BETWEEN 1 AND 64),
        asked_at           INTEGER NOT NULL,
        answered_at        INTEGER NULL
      );
      CREATE INDEX IF NOT EXISTS idx_card_outcome_followups_open
        ON card_outcome_followups(asked_at) WHERE answered_at IS NULL;

      -- 人間が確定した席 (§4)。席の無いカードは行を持たない。
      CREATE TABLE IF NOT EXISTS card_seats (
        card_id      TEXT PRIMARY KEY REFERENCES clone_cards(id) ON DELETE CASCADE,
        seat         TEXT NOT NULL CHECK (seat IN (${SEATS})),
        confirmed_by TEXT NOT NULL CHECK (length(confirmed_by) BETWEEN 1 AND ${AUTHOR_MAX}),
        confirmed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_card_seats_seat ON card_seats(seat);

      -- 分類の提案 (§4)。提案は AI、確定は人間。
      CREATE TABLE IF NOT EXISTS card_seat_proposals (
        card_id       TEXT PRIMARY KEY REFERENCES clone_cards(id) ON DELETE CASCADE,
        proposed_seat TEXT NULL CHECK (proposed_seat IS NULL OR proposed_seat IN (${SEATS})),
        confidence    REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        status        TEXT NOT NULL CHECK (status IN (${PROPOSAL_STATUSES})),
        decided_seat  TEXT NULL CHECK (decided_seat IS NULL OR decided_seat IN (${SEATS})),
        decided_by    TEXT NULL CHECK (decided_by IS NULL OR length(decided_by) BETWEEN 1 AND ${AUTHOR_MAX}),
        decided_at    INTEGER NULL,
        created_at    INTEGER NOT NULL,
        CHECK ((status = 'proposed') = (decided_by IS NULL AND decided_at IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_card_seat_proposals_status
        ON card_seat_proposals(status, created_at);
    `);
  },
};
