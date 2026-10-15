import type { Classifier, Disclosure } from "../classify/classifier.js";
import type { CloneCard } from "../domain/card.js";
import type {
  JudgmentSeat,
  SeatDecision,
  SeatProposal,
  SeatProposalStatus,
} from "../domain/seat.js";
import { CardNotFoundError } from "../feedback/feedback-service.js";
import { planSeatDecision } from "./seat-decision.js";
import { seatClassifierLabels, toProposedSeat } from "./seat-label.js";
import type { SeatCoverage, SeatRepository } from "./seat-repository.js";

export interface GenerateSeatProposalsResult {
  scanned: number;
  proposed: number;
  failed: number;
}

/** 提案が無い / 既に確定済みのカードへの確定操作。HTTP では 409 にする。 */
export class SeatDecisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatDecisionConflictError";
  }
}

export interface SeatProposalServiceOptions {
  seats: SeatRepository;
  cards: { getById(id: string): CloneCard | null };
  /** null = 判定バックエンド未構成。生成だけが使えず、確定・一覧は使える。 */
  classifier: Classifier | null;
  stdout?: (text: string) => void;
}

const INSTRUCTIONS = [
  "Classify which decision-making seat a judgment card belongs to.",
  "A seat is the role whose question the judgment answers.",
  'If the card is not a decision of any listed seat, choose "none".',
].join("\n");

/**
 * S1-4 — 既存カードへ席を提案し、人間の確定を受ける (spec/feature/judgment-outcome.md §4)。
 * 提案は AI、確定は人間。このサービスはカードの席を自分では決めない。
 *
 * @implements SPEC-GENIUS-SEAT-TAG
 */
export class SeatProposalService {
  readonly #seats: SeatRepository;
  readonly #cards: { getById(id: string): CloneCard | null };
  readonly #classifier: Classifier | null;
  readonly #stdout: (text: string) => void;

  constructor(options: SeatProposalServiceOptions) {
    this.#seats = options.seats;
    this.#cards = options.cards;
    this.#classifier = options.classifier;
    this.#stdout = options.stdout ?? (() => undefined);
  }

  /** 席も提案も無い active カードを `limit` 枚まで分類して提案を作る。 */
  async generate(limit: number): Promise<GenerateSeatProposalsResult> {
    if (this.#classifier === null) {
      throw new Error("seat proposals need a classifier; none is configured for this process");
    }
    const rows = this.#seats.listUnclassified(limit);
    const labels = seatClassifierLabels();
    let proposed = 0;
    let failed = 0;
    for (const [index, row] of rows.entries()) {
      // 1 枚の失敗で残りを止めない (categorize と同じ境界)。失敗カードは提案が
      // 無いまま残るので、次回の生成が同じ SELECT で拾い直す。
      try {
        const judgment = await this.#classifier.choice({
          purpose: "seat-classify",
          instructions: INSTRUCTIONS,
          labels,
          evidence: { situation: row.situation, judgment: row.judgment },
          disclosure: disclosureOf(row.visibility),
        });
        const seat = toProposedSeat(judgment.label);
        if (this.#seats.insertProposal(row.id, seat, judgment.confidence)) proposed += 1;
        this.#stdout(`[seats] ${index + 1}/${rows.length} ${row.id} -> ${seat ?? "none"}\n`);
      } catch (error) {
        failed += 1;
        const name = error instanceof Error ? error.name : "UnknownError";
        this.#stdout(`[seats] ${index + 1}/${rows.length} ${row.id} failed (${name}); skipping\n`);
      }
    }
    return { scanned: rows.length, proposed, failed };
  }

  list(status: SeatProposalStatus | null, limit: number, offset: number): SeatProposal[] {
    return this.#seats.listProposals(status, limit, offset);
  }

  decide(cardId: string, decision: SeatDecision): SeatProposal {
    if (this.#cards.getById(cardId) === null) throw new CardNotFoundError(cardId);
    const proposal = this.#seats.getProposal(cardId);
    if (proposal === null) throw new SeatDecisionConflictError(`No seat proposal for ${cardId}`);
    const plan = planSeatDecision(proposal, decision);
    if (!plan.ok) throw new SeatDecisionConflictError(plan.reason);
    this.#seats.applyDecision(cardId, plan.status, plan.decidedSeat, plan.cardSeat, decision.decidedBy);
    const updated = this.#seats.getProposal(cardId);
    if (updated === null) throw new Error(`Seat proposal for ${cardId} disappeared`);
    return updated;
  }

  coverage(): SeatCoverage {
    return this.#seats.coverage();
  }

  seatsOf(cardIds: readonly string[]): Map<string, JudgmentSeat> {
    return this.#seats.seatsOf(cardIds);
  }
}

/** sensitive なカードはこのマシンの外の判定バックエンドへ渡さない (categorize と同じ)。 */
function disclosureOf(visibility: string): Disclosure {
  return visibility === "public" ? "public" : "local-only";
}
