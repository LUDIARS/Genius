import type { ConcordiaQuestionChannel } from "./concordia-question-channel.js";
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
  readonly #warningSink: (message: string) => void;

  constructor(options: DiscordQuestionRelayOptions) {
    this.#answers = options.answers;
    this.#channel = options.channel;
    this.#maxPerRun = options.maxPerRun;
    this.#queue = options.queue;
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
      try {
        await this.#answers.answer({
          questionId: question.id,
          text: reply.text,
          answeredVia: "discord",
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
