import { ELEGANTIA_OUTBOX_STATES } from "../../elegantia/elegantia-outbox.js";
import type { Migration } from "./types.js";

const STATES = ELEGANTIA_OUTBOX_STATES.map((state) => `'${state}'`).join(", ");

/**
 * Elegantia 登録の outbox (spec/feature/elegantia-route.md §4)。
 *
 * カード本文は持たない (送信時に clone_cards から読み直す)。カードが消えたら行も
 * 消す。未処理行 (pending-*) だけを部分 index で引く。
 */
export const elegantiaOutboxMigration: Migration = {
  version: 12,
  name: "elegantia antipattern outbox",
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS elegantia_outbox (
        card_id      TEXT PRIMARY KEY REFERENCES clone_cards(id) ON DELETE CASCADE,
        state        TEXT NOT NULL CHECK (state IN (${STATES})),
        probability  REAL NULL CHECK (probability IS NULL OR (probability >= 0 AND probability <= 1)),
        elegantia_id TEXT NULL CHECK (elegantia_id IS NULL OR length(elegantia_id) BETWEEN 1 AND 128),
        attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error   TEXT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        sent_at      INTEGER NULL,
        CHECK ((state = 'sent') = (elegantia_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_elegantia_outbox_pending
        ON elegantia_outbox(created_at, card_id)
        WHERE state IN ('pending-classify', 'pending-send');
    `);
  },
};
