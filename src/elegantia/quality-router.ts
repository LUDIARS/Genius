import type { Classifier, Disclosure } from "../classify/classifier.js";
import type { CloneCard } from "../domain/card.js";
import { toElegantiaAntipattern } from "./antipattern-payload.js";
import { ElegantiaRequestError, type ElegantiaAntipatternSink } from "./elegantia-client.js";
import type { ElegantiaOutbox, ElegantiaOutboxRow, ElegantiaOutboxStage } from "./elegantia-outbox.js";
import { qualityRouteEligible } from "./quality-route-eligibility.js";

const INSTRUCTIONS =
  "Decide whether this judgment card states a generalizable product quality standard or " +
  "implementation anti-pattern: a UX quality bar, a responsiveness/latency rule, or a bad " +
  "practice that code review should flag in any product. A one-off personal decision tied to " +
  "a specific situation, schedule, person, project status or workflow preference is not one.";

const CRITERIA = {
  true: "the card is a reusable quality standard or anti-pattern that applies across products",
  false: "the card is an individual situational judgment, preference or project-specific decision",
};

/** ingest run の結果に載せる Elegantia 登録の件数。 */
export interface ElegantiaRouteStats {
  /** この flush で Elegantia に登録できた件数 (既存 = 200 も含む)。 */
  registered: number;
  /** この flush で判定または送信に失敗した件数。行は outbox に残り次回再試行する。 */
  failed: number;
}

/** 判断カード保存直後に呼ばれる受け口 (DistillationService 側の依存)。 */
export interface SavedCardSink {
  onCardSaved(card: CloneCard): void;
}

export interface ElegantiaQualityRouterOptions {
  cards: { getById(id: string): CloneCard | null };
  outbox: ElegantiaOutbox;
  classifier: Classifier;
  sink: ElegantiaAntipatternSink;
  /** yes とみなす Noul 確率の下限。公開面へ出すので誤検知側を高く見積もる。 */
  threshold: number;
  /** 1 回の flush で処理する outbox 行の上限。 */
  maxPerRun: number;
  warningSink?: (message: string) => void;
}

/**
 * 判断カードのうち「製品の品質基準・実装のアンチパターン」に当たるものを
 * Elegantia へ正式登録する (spec/feature/elegantia-route.md)。
 *
 * カードは常に Genius に保存したままで、Elegantia には写しを登録する。保存時は
 * outbox に積むだけ (ingest を外部サービスの応答で遅らせない) で、判定と送信は
 * ingest 末尾の `flush()` が行う。失敗した行は outbox に残り、次回の flush が
 * 再試行する。
 */
export class ElegantiaQualityRouter implements SavedCardSink {
  readonly #cards: ElegantiaQualityRouterOptions["cards"];
  readonly #outbox: ElegantiaOutbox;
  readonly #classifier: Classifier;
  readonly #sink: ElegantiaAntipatternSink;
  readonly #threshold: number;
  readonly #maxPerRun: number;
  readonly #warningSink: (message: string) => void;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: ElegantiaQualityRouterOptions) {
    this.#cards = options.cards;
    this.#outbox = options.outbox;
    this.#classifier = options.classifier;
    this.#sink = options.sink;
    this.#threshold = options.threshold;
    this.#maxPerRun = options.maxPerRun;
    this.#warningSink =
      options.warningSink ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /** public 以外のカードは outbox にも積まない (判定にも乗せない)。 */
  onCardSaved(card: CloneCard): void {
    if (!qualityRouteEligible(card)) return;
    this.#outbox.enqueue(card.id);
  }

  /**
   * 並行する ingest run の flush は直列に流す — 同じ行を二重に判定しないため。
   * 後続の flush は先行分の処理済み行を拾わない。
   */
  flush(): Promise<ElegantiaRouteStats> {
    const next = this.#tail.then(() => this.#flushPending());
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async #flushPending(): Promise<ElegantiaRouteStats> {
    const stats: ElegantiaRouteStats = { registered: 0, failed: 0 };
    for (const row of this.#outbox.listPending(this.#maxPerRun)) {
      const card = this.#cards.getById(row.cardId);
      // 積んだ後に sensitive へ編集・supersede・retire されたカードは送らない。
      if (card === null || !qualityRouteEligible(card)) {
        this.#outbox.markSkipped(row.cardId);
        continue;
      }
      const outcome = await this.#process(row, card);
      if (outcome === "registered") stats.registered += 1;
      if (outcome === "failed") stats.failed += 1;
    }
    return stats;
  }

  async #process(
    row: ElegantiaOutboxRow,
    card: CloneCard,
  ): Promise<"registered" | "rejected" | "failed"> {
    if (row.state === "pending-classify") {
      try {
        const judgment = await this.#classifier.noul({
          purpose: "quality-route",
          instructions: INSTRUCTIONS,
          criteria: CRITERIA,
          threshold: this.#threshold,
          evidence: { situation: card.situation, judgment: card.judgment, rationale: card.rationale },
          disclosure: disclosureOf(card),
        });
        const yes = judgment.probability >= this.#threshold;
        this.#outbox.markClassified(card.id, yes, judgment.probability);
        if (!yes) return "rejected";
      } catch (error) {
        return this.#fail(card.id, "classify", error);
      }
    }
    try {
      const registration = await this.#sink.register(toElegantiaAntipattern(card));
      this.#outbox.markSent(card.id, registration.id);
      return "registered";
    } catch (error) {
      return this.#fail(card.id, "send", error);
    }
  }

  #fail(cardId: string, stage: ElegantiaOutboxStage, error: unknown): "failed" {
    // カード本文・判定バックエンドの応答は載せない。メッセージを出すのは、
    // HTTP status しか含まない ElegantiaRequestError だけ。
    const name = error instanceof Error ? error.name : "UnknownError";
    this.#outbox.recordFailure(cardId, stage, name);
    const detail = error instanceof ElegantiaRequestError ? `: ${error.message}` : "";
    this.#warningSink(`[elegantia] ${stage} failed for card ${cardId} (${name}${detail}); will retry`);
    return "failed";
  }
}

/** 判定対象は public だけだが、送出可否は visibility から申告する (categorize と同じ)。 */
function disclosureOf(card: CloneCard): Disclosure {
  return card.visibility === "public" ? "public" : "local-only";
}
