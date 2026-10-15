import { activeCardClause } from "../cards/active-card-sql.js";
import type { GeniusDatabase } from "../db/database.js";
import {
  judgmentSeatSchema,
  seatProposalStatusSchema,
  type CardSeat,
  type JudgmentSeat,
  type SeatProposal,
  type SeatProposalStatus,
} from "../domain/seat.js";

interface ProposalRow {
  card_id: string;
  proposed_seat: string | null;
  confidence: number;
  status: string;
  decided_seat: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
}

interface CardSeatRow {
  card_id: string;
  seat: string;
  confirmed_by: string;
  confirmed_at: number;
}

export interface UnclassifiedCardRow {
  id: string;
  situation: string;
  judgment: string;
  visibility: string;
}

interface CountRow {
  count: number;
}

export interface SeatCoverage {
  /** active カードの総数。 */
  activeCards: number;
  /** 席が確定している active カード。 */
  seated: number;
  /** 「席なし」を人間が確定した active カード。 */
  confirmedNoSeat: number;
  /** 確定待ちの提案。 */
  pendingProposals: number;
}

function nullableSeat(value: string | null): JudgmentSeat | null {
  return value === null ? null : judgmentSeatSchema.parse(value);
}

function mapProposal(row: ProposalRow): SeatProposal {
  return {
    cardId: row.card_id,
    proposedSeat: nullableSeat(row.proposed_seat),
    confidence: row.confidence,
    status: seatProposalStatusSchema.parse(row.status),
    decidedSeat: nullableSeat(row.decided_seat),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

function mapCardSeat(row: CardSeatRow): CardSeat {
  return {
    cardId: row.card_id,
    seat: judgmentSeatSchema.parse(row.seat),
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
  };
}

/**
 * 席タグと分類提案の永続化 (`card_seats` / `card_seat_proposals`、
 * spec/feature/judgment-outcome.md §4)。判定と規則は持たない。
 */
export class SeatRepository {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;

  constructor(database: GeniusDatabase, options: { clock?: () => number } = {}) {
    this.#database = database;
    this.#clock = options.clock ?? Date.now;
  }

  /** 提案対象: 席が無く、提案もまだ無い active カード (古い順)。 */
  listUnclassified(limit: number): UnclassifiedCardRow[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("seat proposal limit must be a positive integer");
    }
    return this.#database
      .prepare<[number], UnclassifiedCardRow>(
        `SELECT id, situation, judgment, visibility
           FROM clone_cards
          WHERE ${activeCardClause()}
            AND id NOT IN (SELECT card_id FROM card_seats)
            AND id NOT IN (SELECT card_id FROM card_seat_proposals)
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .all(limit);
  }

  /** 提案を記録する。既に提案があれば何もしない (人の確定を上書きしない)。 */
  insertProposal(cardId: string, seat: JudgmentSeat | null, confidence: number): boolean {
    return this.#database
      .prepare(
        `INSERT INTO card_seat_proposals(card_id, proposed_seat, confidence, status, created_at)
         VALUES (?, ?, ?, 'proposed', ?)
         ON CONFLICT(card_id) DO NOTHING`,
      )
      .run(cardId, seat, confidence, this.#clock()).changes === 1;
  }

  getProposal(cardId: string): SeatProposal | null {
    const row = this.#database
      .prepare<[string], ProposalRow>("SELECT * FROM card_seat_proposals WHERE card_id = ?")
      .get(cardId);
    return row === undefined ? null : mapProposal(row);
  }

  listProposals(status: SeatProposalStatus | null, limit: number, offset: number): SeatProposal[] {
    return this.#database
      .prepare<[string | null, string | null, number, number], ProposalRow>(
        `SELECT * FROM card_seat_proposals
          WHERE (? IS NULL OR status = ?)
          ORDER BY created_at ASC, card_id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(status, status, limit, offset)
      .map(mapProposal);
  }

  /** 提案の確定 / 却下とカードの席を 1 トランザクションで書く。 */
  applyDecision(
    cardId: string,
    status: "confirmed" | "rejected",
    decidedSeat: JudgmentSeat | null,
    cardSeat: JudgmentSeat | null,
    decidedBy: string,
  ): void {
    const now = this.#clock();
    this.#database.transaction(() => {
      const changed = this.#database
        .prepare(
          `UPDATE card_seat_proposals
              SET status = ?, decided_seat = ?, decided_by = ?, decided_at = ?
            WHERE card_id = ? AND status = 'proposed'`,
        )
        .run(status, decidedSeat, decidedBy, now, cardId).changes;
      if (changed !== 1) throw new Error(`Seat proposal for ${cardId} is no longer pending`);
      if (cardSeat === null) {
        this.#database.prepare("DELETE FROM card_seats WHERE card_id = ?").run(cardId);
        return;
      }
      this.#database
        .prepare(
          `INSERT INTO card_seats(card_id, seat, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(card_id) DO UPDATE SET
             seat = excluded.seat, confirmed_by = excluded.confirmed_by,
             confirmed_at = excluded.confirmed_at`,
        )
        .run(cardId, cardSeat, decidedBy, now);
    }).immediate();
  }

  getSeat(cardId: string): CardSeat | null {
    const row = this.#database
      .prepare<[string], CardSeatRow>("SELECT * FROM card_seats WHERE card_id = ?")
      .get(cardId);
    return row === undefined ? null : mapCardSeat(row);
  }

  /** 一覧表示用の一括取得。 */
  seatsOf(cardIds: readonly string[]): Map<string, JudgmentSeat> {
    const result = new Map<string, JudgmentSeat>();
    if (cardIds.length === 0) return result;
    const placeholders = cardIds.map(() => "?").join(", ");
    const rows = this.#database
      .prepare<string[], CardSeatRow>(
        `SELECT * FROM card_seats WHERE card_id IN (${placeholders})`,
      )
      .all(...cardIds);
    for (const row of rows) result.set(row.card_id, judgmentSeatSchema.parse(row.seat));
    return result;
  }

  /** 「既存カードの 9 割に席タグ」(バックログ S1-4) の進捗を見るための数。 */
  coverage(): SeatCoverage {
    const count = (sql: string): number =>
      this.#database.prepare<[], CountRow>(sql).get()?.count ?? 0;
    const active = activeCardClause("c");
    return {
      activeCards: count(`SELECT COUNT(*) AS count FROM clone_cards c WHERE ${active}`),
      seated: count(
        `SELECT COUNT(*) AS count FROM card_seats s JOIN clone_cards c ON c.id = s.card_id
          WHERE ${active}`,
      ),
      confirmedNoSeat: count(
        `SELECT COUNT(*) AS count FROM card_seat_proposals p JOIN clone_cards c ON c.id = p.card_id
          WHERE ${active} AND p.status = 'confirmed' AND p.decided_seat IS NULL`,
      ),
      pendingProposals: count(
        "SELECT COUNT(*) AS count FROM card_seat_proposals WHERE status = 'proposed'",
      ),
    };
  }
}
