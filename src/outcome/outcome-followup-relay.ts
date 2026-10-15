import type { CloneCard } from "../domain/card.js";
import type { CardOutcome, OutcomeRecordedVia, RecordOutcomeInput } from "../domain/outcome.js";
import {
  replyAuthorDiscordUserId,
  type ConcordiaChatMessage,
} from "../questions/concordia-question-channel.js";
import { formatOutcomeFollowupText } from "./followup-message.js";
import type { OutcomeFollowupRepository } from "./followup-repository.js";
import { followupDueWindow } from "./followup-window.js";
import { parseOutcomeReply } from "./outcome-reply.js";

export interface OutcomeFollowupChannel {
  post(text: string): Promise<string>;
  replies(since: number): Promise<ConcordiaChatMessage[]>;
}

export interface OutcomeFollowupRelayResult {
  asked: number;
  recorded: number;
}

export interface OutcomeFollowupRelayOptions {
  channel: OutcomeFollowupChannel;
  followups: OutcomeFollowupRepository;
  cards: { getById(id: string): CloneCard | null };
  outcomes: {
    record(cardId: string, input: RecordOutcomeInput, via: OutcomeRecordedVia): CardOutcome;
  };
  delayDays: number;
  windowDays: number;
  maxPerRun: number;
  /** 判断者の Discord user id。null なら返信は取り込まない (補完質問と同じ規則)。 */
  deciderDiscordUserId: string | null;
  clock?: () => number;
  warningSink?: (message: string) => void;
}

/**
 * S1-2 — 判断から既定 14 日後に genius チャンネルで「結果は?」を訊き、
 * 判断者本人の返信で outcome を埋める (spec/feature/judgment-outcome.md §3)。
 *
 * 配信経路は補完質問 (DiscordQuestionRelay) と同じ Concordia の genius チャンネル。
 * 返信は自分が投稿したメッセージ id への `in_reply_to` だけを採るので、
 * 同じチャンネルに流れる補完質問への返信と取り違えない。
 *
 * @implements SPEC-GENIUS-OUTCOME-FOLLOWUP
 */
export class OutcomeFollowupRelay {
  readonly #options: OutcomeFollowupRelayOptions;
  readonly #clock: () => number;
  readonly #warningSink: (message: string) => void;

  constructor(options: OutcomeFollowupRelayOptions) {
    this.#options = options;
    this.#clock = options.clock ?? Date.now;
    this.#warningSink = options.warningSink ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /** 配信 1 回 + 回収 1 回。1 件の失敗で他を止めない。 */
  async run(): Promise<OutcomeFollowupRelayResult> {
    return { asked: await this.#publish(), recorded: await this.#collect() };
  }

  async #publish(): Promise<number> {
    const window = followupDueWindow(
      this.#clock(),
      this.#options.delayDays,
      this.#options.windowDays,
    );
    let asked = 0;
    for (const card of this.#options.followups.listDue(window, this.#options.maxPerRun)) {
      try {
        const messageId = await this.#options.channel.post(
          formatOutcomeFollowupText(card, this.#options.delayDays),
        );
        this.#options.followups.markAsked(card.id, messageId);
        asked += 1;
      } catch (error) {
        this.#warningSink(
          `[outcome] failed to post the follow-up for card ${card.id}: ${describe(error)}`,
        );
      }
    }
    return asked;
  }

  async #collect(): Promise<number> {
    if (this.#options.deciderDiscordUserId === null) {
      this.#warningSink(
        "[outcome] questions.deciderDiscordUserId is unset; outcome replies are not ingested",
      );
      return 0;
    }
    const earliest = this.#options.followups.earliestOutstandingAskedAt();
    if (earliest === null) return 0;
    let replies: ConcordiaChatMessage[];
    try {
      // Genius は Unix ms、Concordia の since は Unix 秒 (DiscordQuestionRelay と同じ変換)。
      replies = await this.#options.channel.replies(Math.floor(earliest / 1_000));
    } catch (error) {
      this.#warningSink(`[outcome] failed to read follow-up replies: ${describe(error)}`);
      return 0;
    }

    let recorded = 0;
    for (const reply of replies) {
      const followup = this.#options.followups.findByDiscordMessageId(String(reply.in_reply_to));
      if (followup === null || followup.answeredAt !== null) continue;
      const authorId = replyAuthorDiscordUserId(reply);
      if (authorId !== this.#options.deciderDiscordUserId) {
        this.#warningSink(
          authorId === null
            ? `[outcome] ignored a reply for card ${followup.cardId} from an unidentified author`
            : `[outcome] ignored a reply for card ${followup.cardId} from a non-decider`,
        );
        continue;
      }
      const card = this.#options.cards.getById(followup.cardId);
      if (card === null) continue;
      const parsed = parseOutcomeReply(reply.text, card.judgment);
      if (!parsed.ok) {
        // 読めない返信は記録しない。follow-up は開いたままなので、書き直せば次回拾う。
        this.#warningSink(
          `[outcome] could not read the reply for card ${card.id}: ${parsed.reason}`,
        );
        continue;
      }
      try {
        this.#options.outcomes.record(
          card.id,
          {
            adoptedDecision: parsed.adoptedDecision,
            actualResult: parsed.actualResult,
            verdict: parsed.verdict,
            recordedBy: authorId,
          },
          "discord",
        );
        this.#options.followups.markAnswered(card.id);
        recorded += 1;
      } catch (error) {
        this.#warningSink(
          `[outcome] failed to record the outcome for card ${card.id}: ${describe(error)}`,
        );
      }
    }
    return recorded;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
