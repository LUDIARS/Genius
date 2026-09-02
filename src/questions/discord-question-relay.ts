import {
  replyAuthorDiscordUserId,
  type ConcordiaQuestionChannel,
} from "./concordia-question-channel.js";
import type { QuestionAnswerService } from "./question-answer-service.js";
import type { QuestionQueueRepository } from "./question-queue-repository.js";

export interface DiscordQuestionRelayResult {
  asked: number;
  answered: number;
}

export interface DiscordQuestionRelayOptions {
  answers: QuestionAnswerService;
  channel: ConcordiaQuestionChannel;
  queue: QuestionQueueRepository;
  /** Questions posted per run. Defaults to the queue's own maxPerRun. */
  maxPerRun: number;
  /**
   * 判断者の Discord user id (`questions.deciderDiscordUserId`)。
   * null = 未設定なら Discord からの回答は 1 件も取り込まない (§4)。
   */
  deciderDiscordUserId: string | null;
  warningSink?: (message: string) => void;
}

/**
 * Q6 — posts eligible questions to the dedicated Genius channel and takes replies back in
 * (spec/feature/active-questioning.md §3.2).
 *
 * A reply is only accepted when it references the exact message a question was
 * posted as. Anything else in the channel is left alone: reading an unrelated
 * message as an answer would write a judgment card nobody agreed to.
 *
 * @implements SPEC-GENIUS-ACTIVE-QUESTION-DISCORD
 */
export class DiscordQuestionRelay {
  readonly #answers: QuestionAnswerService;
  readonly #channel: ConcordiaQuestionChannel;
  readonly #maxPerRun: number;
  readonly #queue: QuestionQueueRepository;
  readonly #deciderDiscordUserId: string | null;
  readonly #warningSink: (message: string) => void;

  constructor(options: DiscordQuestionRelayOptions) {
    this.#answers = options.answers;
    this.#channel = options.channel;
    this.#maxPerRun = options.maxPerRun;
    this.#queue = options.queue;
    this.#deciderDiscordUserId = options.deciderDiscordUserId;
    this.#warningSink = options.warningSink ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /** One publish + collect cycle. Per-question failures never stop the others. */
  async run(): Promise<DiscordQuestionRelayResult> {
    return { asked: await this.#publish(), answered: await this.#collect() };
  }

  async #publish(): Promise<number> {
    let asked = 0;
    for (const question of this.#queue.listUnasked(this.#maxPerRun)) {
      try {
        const messageId = await this.#channel.ask(question);
        this.#queue.markAsked(question.id, messageId);
        asked += 1;
      } catch (error) {
        this.#warningSink(
          `[questions] failed to post question ${question.id} to Discord: ${describe(error)}`,
        );
      }
    }
    return asked;
  }

  async #collect(): Promise<number> {
    // 判断者が決まっていない状態で取り込むと、誰の判断か分からないカードが
    // クローンへ混ざる。 何も採らずに 1 行出して戻る (無言で片方だけ動かさない)。
    if (this.#deciderDiscordUserId === null) {
      this.#warningSink(
        "[questions] questions.deciderDiscordUserId is unset; Discord answers are not ingested",
      );
      return 0;
    }
    const earliestAskedAt = this.#queue.earliestOutstandingAskedAt();
    if (earliestAskedAt === null) return 0;
    let replies;
    try {
      // Genius timestamps are Unix milliseconds; Concordia chat stores and
      // filters `ts` as Unix seconds. Convert at this I/O boundary or the much
      // larger millisecond value makes every poll appear to be in the future.
      replies = await this.#channel.replies(Math.floor(earliestAskedAt / 1_000));
    } catch (error) {
      this.#warningSink(`[questions] failed to read Discord replies: ${describe(error)}`);
      return 0;
    }

    let answered = 0;
    for (const reply of replies) {
      const question = this.#queue.findByDiscordMessageId(String(reply.in_reply_to));
      // Not one of ours, or already answered/dismissed elsewhere.
      if (question === null || question.status !== "open") continue;
      // Genius は特定の一人の判断のクローンなので、別人の回答は取り込まない
      // (2026-09-03 neco 指示: 判断回答者が違う場合は Genius としては不適切)。
      // 捨てたことは warn で見えるようにする — 答えたのに黙って消えると、
      // 回答者は「反映された」と誤解する。
      const authorId = replyAuthorDiscordUserId(reply);
      if (authorId !== this.#deciderDiscordUserId) {
        this.#warningSink(
          authorId === null
            ? `[questions] ignored an answer to ${question.id} from an unidentified author`
            : `[questions] ignored an answer to ${question.id} from a non-decider`,
        );
        continue;
      }
      try {
        await this.#answers.answer({
          questionId: question.id,
          text: reply.text,
          answeredVia: "discord",
          answeredBy: authorId,
        });
        answered += 1;
      } catch (error) {
        this.#warningSink(
          `[questions] failed to apply the Discord answer to ${question.id}: ${describe(error)}`,
        );
      }
    }
    return answered;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
