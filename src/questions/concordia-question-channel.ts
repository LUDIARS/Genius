import { z } from "zod";
import { normalizeLoopbackHttpUrl } from "../config/loopback-url.js";
import type { QuestionRecord } from "./types.js";

/** Concordia /v1/chat の text 上限 (PostSchema.text max 2000)。 */
const MAX_TEXT_LENGTH = 2000;
const MAX_REPLY_MESSAGES = 200;
/** 質問は相談として出す (Concordia の channel enum に存在する値)。 */
const CHANNEL = "consultation";
const AUTHOR_LABEL = "Genius";

/**
 * Concordia が返すメッセージ。id は**数値**なので、`questions.discord_message_id`
 * (TEXT) へ入れるときは文字列化する。ここで受ける形は Concordia 側の正本
 * `src/api/chat.ts` の `serialize()` に合わせてある。
 */
const chatMessageSchema = z.object({
  id: z.number().int().positive(),
  channel: z.literal(CHANNEL),
  author_label: z.string(),
  ts: z.number(),
  text: z.string(),
  in_reply_to: z.number().int().positive().nullable(),
}).loose();

const postResponseSchema = z.object({ message: chatMessageSchema });
const listResponseSchema = z.object({ messages: z.array(chatMessageSchema) });

export type ConcordiaChatMessage = z.infer<typeof chatMessageSchema>;

export class ConcordiaQuestionChannelError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConcordiaQuestionChannelError";
  }
}

/**
 * Raised when something asks to publish a question that is not public. Discord
 * is the one egress out of loopback, so this is refused rather than downgraded
 * or truncated (spec/feature/active-questioning.md §3.2).
 */
export class SensitiveQuestionEgressError extends Error {
  constructor(questionId: string) {
    super(`Question ${questionId} is sensitive and must never be sent to Discord`);
    this.name = "SensitiveQuestionEgressError";
  }
}

export class UnsupportedQuestionEgressError extends Error {
  constructor(questionId: string) {
    super(`Contradiction question ${questionId} must be answered in the WebUI`);
    this.name = "UnsupportedQuestionEgressError";
  }
}

export interface ConcordiaQuestionChannelOptions {
  /** loopback のみ許可 (genius.config.json notify.concordiaBaseUrl)。 */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  warningSink?: (message: string) => void;
}

/**
 * Q6 — public な質問だけを Concordia chat へ出し、返信を拾ってくる経路
 * (spec/feature/active-questioning.md §3.2)。
 *
 * 送るのは質問文と context だけ。カード本文・sourceRef・絶対パス・query_log の
 * 生テキストは載せない。Concordia の channel-archives は Genius 自身の Tier 1
 * ingest 元なので、ここへ出した内容は次の ingest で DB へ戻ってくる。
 *
 * @implements SPEC-GENIUS-ACTIVE-QUESTION-DISCORD
 */
export class ConcordiaQuestionChannel {
  readonly #chatUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #warningSink: (message: string) => void;

  constructor(options: ConcordiaQuestionChannelOptions) {
    const baseUrl = normalizeLoopbackHttpUrl(options.baseUrl, "notify.concordiaBaseUrl");
    this.#chatUrl = new URL("/v1/chat", baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#warningSink = options.warningSink
      ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /** Posts a public question and returns the Concordia message id as text. */
  async ask(question: QuestionRecord): Promise<string> {
    if (question.visibility !== "public") throw new SensitiveQuestionEgressError(question.id);
    if (question.gapKind === "contradiction") {
      throw new UnsupportedQuestionEgressError(question.id);
    }
    const body = {
      channel: CHANNEL,
      author_label: AUTHOR_LABEL,
      session_id: null,
      text: formatQuestionText(question),
    };
    const payload = await this.#request(this.#chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
    });
    return String(postResponseSchema.parse(payload).message.id);
  }

  /**
   * Replies posted after `since` (Unix seconds, Concordia's stored `ts` unit).
   * Genius' own messages are dropped so
   * a question never answers itself, and messages without `in_reply_to` are
   * dropped so an unrelated line in the channel is never read as an answer.
   */
  async replies(since: number): Promise<ConcordiaChatMessage[]> {
    const url = new URL(this.#chatUrl);
    url.searchParams.set("channel", CHANNEL);
    url.searchParams.set("since", String(since));
    url.searchParams.set("limit", String(MAX_REPLY_MESSAGES));
    const payload = await this.#request(url, { method: "GET", redirect: "error" });
    const messages = listResponseSchema.parse(payload).messages;
    if (messages.length === MAX_REPLY_MESSAGES) {
      // Concordia currently returns newest-first and exposes no offset/before
      // cursor. Keep the bounded response for resource safety, but make the
      // possibility of older omitted replies operationally visible.
      this.#warningSink(
        `[questions] Concordia reply poll reached its ${MAX_REPLY_MESSAGES}-message limit; older replies may be omitted`,
      );
    }
    return messages.filter(
      (message) => message.in_reply_to !== null && message.author_label !== AUTHOR_LABEL,
    );
  }

  async #request(url: URL, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (error) {
      throw new ConcordiaQuestionChannelError(
        `Concordia chat request to ${url.pathname} failed`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new ConcordiaQuestionChannelError(
        `Concordia chat request was rejected with HTTP ${response.status}`,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new ConcordiaQuestionChannelError("Concordia chat returned a non-JSON body", {
        cause: error,
      });
    }
  }
}

/** @implements SPEC-GENIUS-ACTIVE-QUESTION-DISCORD */
export function formatQuestionText(question: QuestionRecord): string {
  const text = [
    `[genius] ${question.question}`,
    question.context,
    `(${question.gapKind} / ${question.category})`,
    "この投稿へ返信すると回答として取り込みます。",
  ].join("\n");
  return text.length <= MAX_TEXT_LENGTH ? text : `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}
