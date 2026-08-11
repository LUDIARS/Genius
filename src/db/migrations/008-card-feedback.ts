import {
  CARD_FEEDBACK_RATINGS,
  MAX_FEEDBACK_NOTE_LENGTH,
  MAX_FEEDBACK_SOURCE_LENGTH,
} from "../../domain/feedback.js";
import type { Migration } from "./types.js";

interface TableColumnRow {
  name: string;
}

// 統制語彙は domain/feedback.ts が正本。CHECK 制約へベタ書きすると二重定義になり、
// 語彙を足したときに DB 側だけ古いまま残る。
const RATING_CHECK = CARD_FEEDBACK_RATINGS.map((rating) => `'${rating}'`).join(", ");

/**
 * `card_feedback` — 利用側サービスからのカード評価
 * (spec/feature/card-feedback.md §3)。
 *
 * カード本文ではなく「使ってみた結果」なので、query_log と同じ扱いにする:
 * 公開 export に含めない・カード DTO には集計だけ出す (note は出さない)。
 */
export const cardFeedbackMigration: Migration = {
  version: 8,
  name: "card_feedback and feedback-driven archival",
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS card_feedback (
        id         TEXT PRIMARY KEY,
        card_id    TEXT NOT NULL REFERENCES clone_cards(id) ON DELETE CASCADE,
        rating     TEXT NOT NULL CHECK (rating IN (${RATING_CHECK})),
        -- 由来クエリ。query_log は保持期間で消えるので FK は張らない
        -- (消えた過去クエリのために評価まで消さない)。
        query_id   TEXT NULL CHECK (query_id IS NULL OR length(query_id) BETWEEN 1 AND 64),
        source     TEXT NULL CHECK (
          source IS NULL OR length(source) BETWEEN 1 AND ${MAX_FEEDBACK_SOURCE_LENGTH}
        ),
        note       TEXT NULL CHECK (
          note IS NULL OR length(note) BETWEEN 1 AND ${MAX_FEEDBACK_NOTE_LENGTH}
        ),
        created_at INTEGER NOT NULL
      );
      -- 集計は常に card_id で絞り、再アーカイブ抑止で created_at を比較する。
      CREATE INDEX IF NOT EXISTS idx_card_feedback_card
        ON card_feedback(card_id, created_at);
    `);

    // SQLite に ADD COLUMN IF NOT EXISTS は無いので手で冪等にする (004 と同じ)。
    const columns = database
      .prepare<[], TableColumnRow>("PRAGMA table_info('clone_cards')")
      .all()
      .map((column) => column.name);

    if (!columns.includes("retired_reason")) {
      // NULL = 由来不明 / 人が落とした (既存行はすべてこれ)。
      // 'feedback' = 評価によって自動で落ちた。UI と運用が区別できるようにする。
      database.exec(
        "ALTER TABLE clone_cards ADD COLUMN retired_reason TEXT NULL "
        + "CHECK (retired_reason IS NULL OR retired_reason = 'feedback')",
      );
    }

    if (!columns.includes("feedback_reset_at")) {
      // 再アーカイブ抑止 (§4)。人が un-retire した時刻を入れ、以後はそれより新しい
      // 評価だけを数える。NULL = 一度も戻していない (全期間が対象)。
      database.exec("ALTER TABLE clone_cards ADD COLUMN feedback_reset_at INTEGER NULL");
    }
  },
};
