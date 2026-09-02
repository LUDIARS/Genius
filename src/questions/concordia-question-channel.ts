import { z } from "zod";
import { normalizeLoopbackHttpUrl } from "../config/loopback-url.js";
import type { QuestionRecord } from "./types.js";

/** Concordia /v1/chat の text 上限 (PostSchema.text max 2000)。 */
const MAX_TEXT_LENGTH = 2000;
const MAX_REPLY_MESSAGES = 200;
/**
 * 補完質問は Genius 専用チャンネルへ出す (Concordia の channel enum の値)。
 *
 * 以前は `consultation` (仕事の相談) と同じ面に出していたが、作業の相談と
 * 見分けがつかず「答えるまで進められない問い」に見えていた。Concordia 側で
 * `genius` を新設し専用色を割り当てたので、面ごと分ける。
 *
 * **順序依存**: Concordia が `genius` を受けるようになる前にこちらを配ると、
 * `POST /v1/chat` が 400 を返して質問が出せない (relay は warn を出して継続する
 * ので黙って消えはしないが、質問は届かない)。Concordia を先に反映すること。
 */
const CHANNEL = "genius";
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
 * sensitive な質問を出してよい唯一のチャンネル。
 *
 * `genius` は Discord の **meta カテゴリ**配下に作られる。 Concordia の
 * channel-archives は sessions / archive カテゴリ配下しか書き出さない
 * (`archiveStaleChannels` の targetCategories) ため、 このチャンネルの内容は
 * アーカイブされず、 Genius の Tier1 ingest (`channelArchivesDir`) へ環流しない。
 * **これが sensitive を許せる唯一の根拠**なので、 送り先チャンネルを変えるときは
 * この前提を必ず再検証すること (2026-09-03 neco 指示 + 実装確認)。
 */
const SENSITIVE_ALLOWED_CHANNEL = "genius";

/**
 * Raised when something asks to publish a sensitive question somewhere other
 * than the dedicated genius channel. Discord is the one egress out of loopback,
 * so this is refused rather than downgraded or truncated
 * (spec/feature/active-questioning.md §3.2).
 */
export class SensitiveQuestionEgressError extends Error {
  constructor(questionId: string) {
    super(`Question ${questionId} is sensitive and may only be sent to the ${SENSITIVE_ALLOWED_CHANNEL} channel`);
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
 * Q6 — 質問を専用の Genius channel へ出し、返信を拾ってくる経路
 * (spec/feature/active-questioning.md §3.2)。
 *
 * 送るのは質問文と context だけ。カード本文・sourceRef・絶対パス・query_log の
 * 生テキストは載せない。`genius` は channel-archives の対象外なので、ここへ
 * 出した内容は Genius の Tier 1 ingest へ環流しない。
 *
 * @implements SPEC-GENIUS-ACTIVE-QUESTION-DISCORD
 */
export class ConcordiaQuestionChannel {
  readonly #chatUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #warningSink: (message: string) => void;

  /** @implements SPEC-GENIUS-ACTIVE-QUESTION-DISCORD */
  constructor(options: ConcordiaQuestionChannelOptions) {
    const baseUrl = normalizeLoopbackHttpUrl(options.baseUrl, "notify.concordiaBaseUrl");
    this.#chatUrl = new URL("/v1/chat", baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#warningSink = options.warningSink
      ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /**
   * Posts a question to the genius channel and returns its message id as text.
   * @implements SPEC-GENIUS-ACTIVE-QUESTION-DISCORD
   */
  async ask(question: QuestionRecord): Promise<string> {
    // sensitive は専用チャンネルのときだけ許す。 CHANNEL を戻すと (= 環流する面へ
    // 出すようになると) ここで落ちる — 前提が崩れたまま黙って送らないための番人。
    if (question.visibility !== "public" && CHANNEL !== SENSITIVE_ALLOWED_CHANNEL) {
      throw new SensitiveQuestionEgressError(question.id);
    }
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
    "この投稿へ返信すると回答として取り込みます。",
  ].join("\n");
  return text.length <= MAX_TEXT_LENGTH ? text : `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}
