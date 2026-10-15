import type { GeniusDatabase } from "../db/database.js";
import {
  toCardOutcome,
  type CardOutcome,
  type CardOutcomeRow,
  type OutcomeRecordedVia,
  type RecordOutcomeInput,
} from "../domain/outcome.js";
import type { OutcomeStatRow } from "./outcome-stats.js";

export interface OutcomeStatsFilter {
  /** 判断日 (clone_cards.created_at) の下限 (含む、epoch ms)。 */
  from: number | null;
  /** 判断日の上限 (含まない、epoch ms)。 */
  to: number | null;
}

/**
 * `card_outcomes` の永続化 (spec/feature/judgment-outcome.md §2)。
 * 1 枚に 1 行。書き直しは上書き (最後に書いた人と時刻が残る)。
 */
export class CardOutcomeRepository {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;

  constructor(database: GeniusDatabase, options: { clock?: () => number } = {}) {
    this.#database = database;
    this.#clock = options.clock ?? Date.now;
  }

  upsert(cardId: string, input: RecordOutcomeInput, via: OutcomeRecordedVia): CardOutcome {
    this.#database
      .prepare(
        `INSERT INTO card_outcomes(
           card_id, adopted_decision, actual_result, verdict, recorded_by, recorded_via, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(card_id) DO UPDATE SET
           adopted_decision = excluded.adopted_decision,
           actual_result    = excluded.actual_result,
           verdict          = excluded.verdict,
           recorded_by      = excluded.recorded_by,
           recorded_via     = excluded.recorded_via,
           recorded_at      = excluded.recorded_at`,
      )
      .run(
        cardId,
        input.adoptedDecision,
        input.actualResult,
        input.verdict,
        input.recordedBy,
        via,
        this.#clock(),
      );
    const stored = this.get(cardId);
    if (stored === null) throw new Error(`Outcome was not stored for card ${cardId}`);
    return stored;
  }

  get(cardId: string): CardOutcome | null {
    return toCardOutcome(
      this.#database
        .prepare<[string], CardOutcomeRow>("SELECT * FROM card_outcomes WHERE card_id = ?")
        .get(cardId),
    );
  }

  /** 一覧表示用。カード 1 枚ごとに問い合わせない (feedback の summaries と同じ)。 */
  getMany(cardIds: readonly string[]): Map<string, CardOutcome> {
    const result = new Map<string, CardOutcome>();
    if (cardIds.length === 0) return result;
    const placeholders = cardIds.map(() => "?").join(", ");
    const rows = this.#database
      .prepare<string[], CardOutcomeRow>(
        `SELECT * FROM card_outcomes WHERE card_id IN (${placeholders})`,
      )
      .all(...cardIds);
    for (const row of rows) {
      const outcome = toCardOutcome(row);
      if (outcome !== null) result.set(outcome.cardId, outcome);
    }
    return result;
  }

  /**
   * 席 × verdict の件数。席の無いカードは seat = NULL の行に入る。
   * 期間は判断日 (カードの created_at) で切る (§5)。
   */
  statRows(filter: OutcomeStatsFilter): OutcomeStatRow[] {
    return this.#database
      .prepare<[number | null, number | null, number | null, number | null], OutcomeStatRow>(
        `SELECT s.seat AS seat, o.verdict AS verdict, COUNT(*) AS count
           FROM card_outcomes o
           JOIN clone_cards c ON c.id = o.card_id
           LEFT JOIN card_seats s ON s.card_id = o.card_id
          WHERE (? IS NULL OR c.created_at >= ?)
            AND (? IS NULL OR c.created_at < ?)
          GROUP BY s.seat, o.verdict`,
      )
      .all(filter.from, filter.from, filter.to, filter.to);
  }
}
