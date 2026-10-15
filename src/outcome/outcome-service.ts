import type { CloneCard } from "../domain/card.js";
import type {
  CardOutcome,
  OutcomeRecordedVia,
  RecordOutcomeInput,
} from "../domain/outcome.js";
import { CardNotFoundError } from "../feedback/feedback-service.js";
import type { CardOutcomeRepository } from "./outcome-repository.js";
import { summarizeOutcomeStats, type OutcomeStats, type OutcomeStatsQuery } from "./outcome-stats.js";

export interface OutcomeCardsPort {
  getById(id: string): CloneCard | null;
}

/**
 * outcome の記録と照会 (spec/feature/judgment-outcome.md §2・§5)。
 *
 * 存在しないカードは 404 にしたいので card-feedback と同じ CardNotFoundError を使う。
 * retire / supersede 済みのカードにも書ける: 判断の結果はカードが退役しても
 * 「その判断が当たったか」の記録として意味を持つ。
 *
 * @implements SPEC-GENIUS-OUTCOME-RECORD
 */
export class CardOutcomeService {
  readonly #cards: OutcomeCardsPort;
  readonly #outcomes: CardOutcomeRepository;

  constructor(cards: OutcomeCardsPort, outcomes: CardOutcomeRepository) {
    this.#cards = cards;
    this.#outcomes = outcomes;
  }

  record(cardId: string, input: RecordOutcomeInput, via: OutcomeRecordedVia): CardOutcome {
    if (this.#cards.getById(cardId) === null) throw new CardNotFoundError(cardId);
    return this.#outcomes.upsert(cardId, input, via);
  }

  get(cardId: string): CardOutcome | null {
    if (this.#cards.getById(cardId) === null) throw new CardNotFoundError(cardId);
    return this.#outcomes.get(cardId);
  }

  getMany(cardIds: readonly string[]): Map<string, CardOutcome> {
    return this.#outcomes.getMany(cardIds);
  }

  /** @implements SPEC-GENIUS-OUTCOME-STATS */
  stats(query: OutcomeStatsQuery): OutcomeStats {
    if (query.from !== null && query.to !== null && query.from >= query.to) {
      throw new RangeError("from must be earlier than to");
    }
    return summarizeOutcomeStats(
      this.#outcomes.statRows({ from: query.from, to: query.to }),
      query,
    );
  }
}
