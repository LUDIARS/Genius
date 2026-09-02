import { describe, expect, it, vi } from "vitest";
import {
  ConcordiaQuestionChannel,
  UnsupportedQuestionEgressError,
  formatQuestionText,
} from "../../src/questions/concordia-question-channel.js";
import { DiscordQuestionRelay } from "../../src/questions/discord-question-relay.js";
import { IngestQuestionHook } from "../../src/questions/ingest-question-hook.js";
import type { QuestionGenerationService } from "../../src/questions/question-generation-service.js";
import type { QuestionAnswerService } from "../../src/questions/question-answer-service.js";
import type { QuestionQueueRepository } from "../../src/questions/question-queue-repository.js";
import type { QuestionQueueEntry, QuestionRecord } from "../../src/questions/types.js";

const BASE_URL = "http://127.0.0.1:11111";

function question(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id: "Q1",
    question: "この場面ではどう判断しますか?",
    context: "検索の top1 類似度が閾値未満だった",
    category: "review",
    domain: "work",
    visibility: "public",
    gapKind: "retrieval-miss",
    status: "open",
    askedAt: null,
    answeredAt: null,
    discordMessageId: null,
    createdAt: 1,
    targets: [{ kind: "query_log", id: "LOG1" }],
    ...overrides,
  };
}

function entry(overrides: Partial<QuestionQueueEntry> = {}): QuestionQueueEntry {
  return { ...question(), answers: [], pairCardIds: null, ...overrides };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Concordia question channel (Q6)", () => {
  it("posts a public question and returns the message id as text", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: { id: 4321, channel: "genius", author_label: "Genius", ts: 1, text: "x", in_reply_to: null } }));
    const channel = new ConcordiaQuestionChannel({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });

    const messageId = await channel.ask(question());

    expect(messageId).toBe("4321");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/chat");
    const body = JSON.parse(String(init.body)) as { channel: string; author_label: string; text: string };
    expect(body.channel).toBe("genius");
    expect(body.author_label).toBe("Genius");
    expect(body.text).toContain("この場面ではどう判断しますか?");
  });

  it("sends a sensitive question to the dedicated genius channel", async () => {
    // genius は meta カテゴリ配下で channel-archives の対象外 = Tier1 ingest へ
    // 環流しない。 それが sensitive を許せる根拠 (spec §3.2)。
    const fetchMock = vi.fn(async () => jsonResponse({ message: { id: 99, channel: "genius", author_label: "Genius", ts: 1, text: "x", in_reply_to: null } }));
    const channel = new ConcordiaQuestionChannel({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });

    await expect(channel.ask(question({ visibility: "sensitive" }))).resolves.toBe("99");
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const body = JSON.parse(String(init.body)) as { channel: string };
    expect(body.channel).toBe("genius");
  });

  it("still refuses contradiction questions regardless of visibility", async () => {
    const fetchMock = vi.fn();
    const channel = new ConcordiaQuestionChannel({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });

    await expect(channel.ask(question({ visibility: "sensitive", gapKind: "contradiction" })))
      .rejects.toThrow(UnsupportedQuestionEgressError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to send contradiction questions that require a WebUI winner", async () => {
    const fetchMock = vi.fn();
    const channel = new ConcordiaQuestionChannel({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });

    await expect(channel.ask(question({ gapKind: "contradiction" })))
      .rejects.toThrow(UnsupportedQuestionEgressError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps evidence out of the posted text", () => {
    const text = formatQuestionText(question());
    expect(text).not.toContain("LOG1");
    expect(text).not.toContain("E:\\");
    expect(text).not.toContain("retrieval-miss");
    expect(text).not.toContain("review");
  });

  it("drops replies without in_reply_to and Genius' own messages", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      messages: [
        { id: 1, channel: "genius", author_label: "neco", ts: 5, text: "answer", in_reply_to: 4321, metadata: { discord_user_id: "U-neco" } },
        { id: 2, channel: "genius", author_label: "neco", ts: 6, text: "unrelated", in_reply_to: null },
        { id: 3, channel: "genius", author_label: "Genius", ts: 7, text: "own", in_reply_to: 4321 },
      ],
    }));
    const channel = new ConcordiaQuestionChannel({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });

    const replies = await channel.replies(4);

    expect(replies.map((reply) => reply.id)).toEqual([1]);
    expect(replies[0]?.metadata?.discord_user_id).toBe("U-neco");
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("channel")).toBe("genius");
    expect(url.searchParams.get("since")).toBe("4");
  });

  it("warns when Concordia saturates its bounded newest-first reply window", async () => {
    const warnings: string[] = [];
    const messages = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      channel: "genius",
      author_label: "neco",
      ts: index + 1,
      text: "answer",
      in_reply_to: 4321,
    }));
    const channel = new ConcordiaQuestionChannel({
      baseUrl: BASE_URL,
      fetch: (async () => jsonResponse({ messages })) as typeof fetch,
      warningSink: (message) => warnings.push(message),
    });

    await expect(channel.replies(0)).resolves.toHaveLength(200);
    expect(warnings.join(" ")).toContain("older replies may be omitted");
  });
});

describe("Discord question relay (Q6)", () => {
  it("posts unasked questions and applies replies to the matching question", async () => {
    const asked: { id: string; messageId: string }[] = [];
    const answered: { questionId: string; answeredVia: string; text: string; answeredBy?: string }[] = [];
    const replySince: number[] = [];
    const queue = {
      listUnasked: () => [entry()],
      markAsked: (id: string, messageId: string) => asked.push({ id, messageId }),
      earliestOutstandingAskedAt: () => 10_500,
      findByDiscordMessageId: (id: string) => (id === "4321" ? entry({ discordMessageId: "4321" }) : null),
    } as unknown as QuestionQueueRepository;
    const answers = {
      answer: async (input: { questionId: string; answeredVia: string; text: string; answeredBy?: string }) => {
        answered.push(input);
        return {} as never;
      },
    } as unknown as QuestionAnswerService;
    const channel = {
      ask: async () => "4321",
      replies: async (since: number) => {
        replySince.push(since);
        return [
          { id: 1, author_label: "neco", ts: 11, text: "こう判断する", in_reply_to: 4321, metadata: { discord_user_id: "U-neco" } },
          { id: 2, author_label: "neco", ts: 12, text: "別スレッド", in_reply_to: 9999, metadata: { discord_user_id: "U-neco" } },
        ];
      },
    } as unknown as ConcordiaQuestionChannel;

    const result = await new DiscordQuestionRelay({ answers, channel, queue, maxPerRun: 5, deciderDiscordUserId: "U-neco" }).run();

    expect(result).toEqual({ asked: 1, answered: 1 });
    expect(asked).toEqual([{ id: "Q1", messageId: "4321" }]);
    expect(replySince).toEqual([10]);
    // The reply to an unknown message id is left alone.
    expect(answered).toEqual([
      { questionId: "Q1", answeredVia: "discord", text: "こう判断する", answeredBy: "U-neco" },
    ]);
  });

  /** 回答取り込みだけを見るための最小構成。返信の投稿者だけ差し替える。 */
  function collectOnlyRelay(options: {
    deciderDiscordUserId: string | null;
    replyAuthorId?: string;
    answered: unknown[];
    warnings: string[];
  }) {
    const queue = {
      listUnasked: () => [],
      markAsked: () => {},
      earliestOutstandingAskedAt: () => 10_500,
      findByDiscordMessageId: (id: string) => (id === "4321" ? entry({ discordMessageId: "4321" }) : null),
    } as unknown as QuestionQueueRepository;
    const answers = {
      answer: async (input: unknown) => {
        options.answered.push(input);
        return {} as never;
      },
    } as unknown as QuestionAnswerService;
    const channel = {
      ask: async () => "4321",
      replies: async () => [{
        id: 1,
        author_label: "誰か",
        ts: 11,
        text: "こう判断する",
        in_reply_to: 4321,
        ...(options.replyAuthorId === undefined
          ? {}
          : { metadata: { discord_user_id: options.replyAuthorId } }),
      }],
    } as unknown as ConcordiaQuestionChannel;
    return new DiscordQuestionRelay({
      answers,
      channel,
      queue,
      maxPerRun: 5,
      deciderDiscordUserId: options.deciderDiscordUserId,
      warningSink: (message) => options.warnings.push(message),
    });
  }

  it("records who decided, so the card carries its author", async () => {
    const answered: Array<{ answeredBy?: string }> = [];
    const warnings: string[] = [];
    const relay = collectOnlyRelay({
      deciderDiscordUserId: "U-neco",
      replyAuthorId: "U-neco",
      answered,
      warnings,
    });

    await expect(relay.run()).resolves.toEqual({ asked: 0, answered: 1 });
    expect(answered[0]?.answeredBy).toBe("U-neco");
  });

  it("ignores an answer from someone other than the decider", async () => {
    // Genius は特定の一人の判断のクローンなので、別人の判断を取り込むと汚れる。
    const answered: unknown[] = [];
    const warnings: string[] = [];
    const relay = collectOnlyRelay({
      deciderDiscordUserId: "U-neco",
      replyAuthorId: "U-someone-else",
      answered,
      warnings,
    });

    await expect(relay.run()).resolves.toEqual({ asked: 0, answered: 0 });
    expect(answered).toEqual([]);
    // 黙って捨てない — 答えた側が「反映された」と誤解しないように残す。
    expect(warnings.join(" ")).toContain("non-decider");
    expect(warnings.join(" ")).not.toContain("U-someone-else");
  });

  it("ignores a reply whose author cannot be identified", async () => {
    const answered: unknown[] = [];
    const warnings: string[] = [];
    const relay = collectOnlyRelay({ deciderDiscordUserId: "U-neco", answered, warnings });

    await expect(relay.run()).resolves.toEqual({ asked: 0, answered: 0 });
    expect(answered).toEqual([]);
    expect(warnings.join(" ")).toContain("unidentified author");
  });

  it("ingests nothing while the decider is unconfigured", async () => {
    const answered: unknown[] = [];
    const warnings: string[] = [];
    const relay = collectOnlyRelay({
      deciderDiscordUserId: null,
      replyAuthorId: "U-neco",
      answered,
      warnings,
    });

    await expect(relay.run()).resolves.toEqual({ asked: 0, answered: 0 });
    expect(answered).toEqual([]);
    expect(warnings.join(" ")).toContain("deciderDiscordUserId is unset");
  });

  it("keeps going when one question fails to post", async () => {
    const warnings: string[] = [];
    const queue = {
      listUnasked: () => [entry({ id: "QBAD" }), entry({ id: "QOK" })],
      markAsked: () => {},
      earliestOutstandingAskedAt: () => null,
      findByDiscordMessageId: () => null,
    } as unknown as QuestionQueueRepository;
    const channel = {
      ask: async (q: QuestionRecord) => {
        if (q.id === "QBAD") throw new Error("Concordia rejected it");
        return "1";
      },
    } as unknown as ConcordiaQuestionChannel;

    const result = await new DiscordQuestionRelay({
      answers: {} as unknown as QuestionAnswerService,
      channel,
      queue,
      maxPerRun: 5,
      deciderDiscordUserId: "U-neco",
      warningSink: (message) => warnings.push(message),
    }).run();

    expect(result.asked).toBe(1);
    expect(warnings.join(" ")).toContain("QBAD");
  });
});

describe("ingest completion hook (Q8)", () => {
  it("prunes the query log, generates, relays, and reports the counts", async () => {
    const calls: string[] = [];
    const hook = new IngestQuestionHook({
      questions: {
        generate: async () => {
          calls.push("generate");
          return { created: [question(), question()], skipped: 0, openCount: 7 };
        },
      } as unknown as QuestionGenerationService,
      queryLog: {
        deleteExpired: (days: number) => {
          calls.push(`prune:${days}`);
          return 3;
        },
      } as never,
      retentionDays: 30,
      relay: {
        run: async () => {
          calls.push("relay");
          return { asked: 1, answered: 0 };
        },
      },
      warningSink: () => {},
    });

    const result = await hook.onRunCompleted();

    expect(result).toEqual({ created: 2, openCount: 7 });
    expect(calls).toEqual(["prune:30", "generate", "relay"]);
  });

  it("still reports the generated questions when the Discord relay fails", async () => {
    const warnings: string[] = [];
    const hook = new IngestQuestionHook({
      questions: {
        generate: async () => ({ created: [question()], skipped: 0, openCount: 1 }),
      } as unknown as QuestionGenerationService,
      relay: { run: async () => { throw new Error("Concordia is down"); } },
      warningSink: (message) => warnings.push(message),
    });

    const result = await hook.onRunCompleted();

    expect(result).toEqual({ created: 1, openCount: 1 });
    expect(warnings.join(" ")).toContain("Discord relay failed");
  });

  it("still collects Discord replies when question generation fails", async () => {
    let relayed = false;
    const hook = new IngestQuestionHook({
      questions: {
        generate: async () => { throw new Error("generation failed"); },
      } as unknown as QuestionGenerationService,
      relay: {
        run: async () => {
          relayed = true;
          return { asked: 0, answered: 1 };
        },
      },
      warningSink: () => {},
    });

    await expect(hook.onRunCompleted()).rejects.toThrow("generation failed");
    expect(relayed).toBe(true);
  });
});
