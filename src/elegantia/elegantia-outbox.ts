import type { GeniusDatabase } from "../db/database.js";

/**
 * outbox 行の状態。
 * - pending-classify: 保存直後。品質基準/アンチパターンかをまだ判定していない
 * - pending-send: yes と判定済み。Elegantia へ未登録
 * - sent: Elegantia に登録済み (elegantia_id あり)
 * - rejected: no と判定 (送らない)
 * - skipped: 判定前に public / active でなくなった (送らない)
 */
export const ELEGANTIA_OUTBOX_STATES = [
  "pending-classify",
  "pending-send",
  "sent",
  "rejected",
  "skipped",
] as const;

export type ElegantiaOutboxState = (typeof ELEGANTIA_OUTBOX_STATES)[number];

export interface ElegantiaOutboxRow {
  cardId: string;
  state: "pending-classify" | "pending-send";
  attempts: number;
}

export type ElegantiaOutboxStage = "classify" | "send";

interface OutboxRow {
  card_id: string;
  state: ElegantiaOutboxRow["state"];
  attempts: number;
}

/**
 * Elegantia 登録の outbox (SQLite)。
 *
 * カード保存と同じ DB に積むことで、Elegantia 不達・判定失敗があっても
 * 「送るべきカード」を失わない。失敗は行に残し (last_error / attempts)、次回の
 * ingest の flush が拾い直す。本文は持たない — 送信時に clone_cards から
 * 読み直すので、編集で sensitive に変わったカードを古い本文のまま送らない。
 */
export class ElegantiaOutbox {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;

  constructor(database: GeniusDatabase, clock: () => number = Date.now) {
    this.#database = database;
    this.#clock = clock;
  }

  /** 同じカードは 1 回だけ積む (再 ingest で状態を巻き戻さない)。 */
  enqueue(cardId: string): void {
    const now = this.#clock();
    this.#database
      .prepare(
        `INSERT INTO elegantia_outbox(card_id, state, attempts, created_at, updated_at)
         VALUES (?, 'pending-classify', 0, ?, ?)
         ON CONFLICT(card_id) DO NOTHING`,
      )
      .run(cardId, now, now);
  }

  /** 未処理の行を古い順に返す。 */
  listPending(limit: number): ElegantiaOutboxRow[] {
    return this.#database
      .prepare<[number], OutboxRow>(
        `SELECT card_id, state, attempts FROM elegantia_outbox
          WHERE state IN ('pending-classify', 'pending-send')
          ORDER BY created_at, card_id
          LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({ cardId: row.card_id, state: row.state, attempts: row.attempts }));
  }

  markClassified(cardId: string, yes: boolean, probability: number): void {
    this.#update(
      `UPDATE elegantia_outbox
          SET state = ?, probability = ?, last_error = NULL, updated_at = ?
        WHERE card_id = ?`,
      yes ? "pending-send" : "rejected",
      probability,
      this.#clock(),
      cardId,
    );
  }

  markSent(cardId: string, elegantiaId: string): void {
    const now = this.#clock();
    this.#update(
      `UPDATE elegantia_outbox
          SET state = 'sent', elegantia_id = ?, last_error = NULL, sent_at = ?, updated_at = ?
        WHERE card_id = ?`,
      elegantiaId,
      now,
      now,
      cardId,
    );
  }

  markSkipped(cardId: string): void {
    this.#update(
      `UPDATE elegantia_outbox SET state = 'skipped', updated_at = ? WHERE card_id = ?`,
      this.#clock(),
      cardId,
    );
  }

  /** 状態は変えずに失敗を記録する (次回の flush が再試行する)。 */
  recordFailure(cardId: string, stage: ElegantiaOutboxStage, errorName: string): void {
    this.#update(
      `UPDATE elegantia_outbox
          SET attempts = attempts + 1, last_error = ?, updated_at = ?
        WHERE card_id = ?`,
      `${stage}: ${errorName}`.slice(0, 200),
      this.#clock(),
      cardId,
    );
  }

  #update(sql: string, ...params: (string | number)[]): void {
    const result = this.#database.prepare(sql).run(...params);
    if (result.changes !== 1) {
      throw new Error(`Elegantia outbox row is missing: ${String(params.at(-1))}`);
    }
  }
}
