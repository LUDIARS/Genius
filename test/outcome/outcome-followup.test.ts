import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardRepository } from "../../src/cards/index.js";
import type { GeniusDatabase } from "../../src/db/database.js";
import { openDatabase, runMigrations } from "../../src/db/index.js";
import type { CloneCard, CreateCardInput } from "../../src/domain/card.js";
import { formatOutcomeFollowupText } from "../../src/outcome/followup-message.js";
import { OutcomeFollowupRepository } from "../../src/outcome/followup-repository.js";
import { followupDueWindow } from "../../src/outcome/followup-window.js";
import { OutcomeFollowupRelay } from "../../src/outcome/outcome-followup-relay.js";
import { parseOutcomeReply } from "../../src/outcome/outcome-reply.js";
import { CardOutcomeRepository } from "../../src/outcome/outcome-repository.js";
import { CardOutcomeService } from "../../src/outcome/outcome-service.js";
import type { ConcordiaChatMessage } from "../../src/questions/concordia-question-channel.js";
import { IngestQuestionHook } from "../../src/questions/ingest-question-hook.js";
import type { QuestionGenerationService } from "../../src/questions/question-generation-service.js";

const DAY = 24 * 60 * 60 * 1_000;
const DECIDER = "1234567890";

let refSeq = 0;

function input(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
  return {
    domain: "work",
    visibility: "public",
    category: null,
    situation: "A secret situation that must not leave",
    judgment: "Ship behind a feature flag",
    rationale: "A secret rationale that must not leave",
    tags: [],
    confidence: 0.8,
    sourceRef: `C:/private/path-${++refSeq}.md`,
    sourceTier: 1,
    ...overrides,
  };
}

describe("parseOutcomeReply", () => {
  it("reads 不一致 as a mismatch even though it contains 一致", () => {
    expect(parseOutcomeReply("不一致\n予定より 1 週間遅れた", "card judgment")).toEqual({
      ok: true,
      verdict: "mismatch",
      adoptedDecision: "card judgment",
      actualResult: "予定より 1 週間遅れた",
    });
  });

  it("takes the result from the first line and an explicit adopted decision", () => {
    expect(parseOutcomeReply("一致: 問題なく出せた\n採用: フラグ付きで出す", "x")).toEqual({
      ok: true,
      verdict: "match",
      adoptedDecision: "フラグ付きで出す",
      actualResult: "問題なく出せた",
    });
    expect(parseOutcomeReply("MATCH shipped fine", "x")).toMatchObject({ verdict: "match" });
  });

  it("refuses replies it cannot read instead of guessing", () => {
    expect(parseOutcomeReply("", "x")).toMatchObject({ ok: false });
    expect(parseOutcomeReply("たぶん大丈夫だった", "x")).toMatchObject({ ok: false });
    expect(parseOutcomeReply("一致", "x")).toMatchObject({ ok: false });
    expect(parseOutcomeReply("一致した気がする", "x")).toMatchObject({ ok: false });
  });
});

describe("followupDueWindow", () => {
  it("covers decisions between delay and delay + window days ago", () => {
    const now = 100 * DAY;
    expect(followupDueWindow(now, 14, 7)).toEqual({ decidedFrom: 79 * DAY, decidedTo: 86 * DAY });
    expect(() => followupDueWindow(now, 0, 7)).toThrow(RangeError);
    expect(() => followupDueWindow(now, 14, 0)).toThrow(RangeError);
  });
});

describe("formatOutcomeFollowupText", () => {
  const base = {
    id: "card-1",
    situation: "secret situation",
    judgment: "Ship behind a feature flag",
    rationale: "secret rationale",
    sourceRef: "C:/private/path.md",
  };

  it("carries only the card id and, for public cards, the judgment", () => {
    const text = formatOutcomeFollowupText({ ...base, visibility: "public" } as CloneCard, 14);
    expect(text).toContain("card-1");
    expect(text).toContain("Ship behind a feature flag");
    expect(text).toContain("14 日");
    for (const leaked of ["secret", "C:/private"]) expect(text).not.toContain(leaked);
  });

  it("omits the judgment of sensitive cards", () => {
    const text = formatOutcomeFollowupText({ ...base, visibility: "sensitive" } as CloneCard, 14);
    expect(text).not.toContain("Ship behind a feature flag");
    expect(text).toContain("WebUI");
  });
});

describe("OutcomeFollowupRelay", () => {
  let database: GeniusDatabase;
  let cards: CardRepository;
  let outcomes: CardOutcomeService;
  let followups: OutcomeFollowupRepository;
  let now: number;
  let posted: string[];
  let replies: ConcordiaChatMessage[];
  let warnings: string[];
  let id = 0;

  function reply(inReplyTo: number, text: string, author: string | null = DECIDER): ConcordiaChatMessage {
    return {
      id: 900 + replies.length,
      channel: "genius",
      author_label: "neco",
      ts: 1,
      text,
      in_reply_to: inReplyTo,
      metadata: author === null ? null : { discord_user_id: author },
    };
  }

  function relay(decider: string | null = DECIDER): OutcomeFollowupRelay {
    return new OutcomeFollowupRelay({
      channel: {
        post: async (text) => {
          posted.push(text);
          return String(100 + posted.length);
        },
        replies: async () => replies,
      },
      followups,
      cards,
      outcomes,
      delayDays: 14,
      windowDays: 7,
      maxPerRun: 2,
      deciderDiscordUserId: decider,
      clock: () => now,
      warningSink: (message) => warnings.push(message),
    });
  }

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    let createdAt = 0;
    cards = new CardRepository(database, { idFactory: () => `card-${++id}`, clock: () => createdAt });
    // 判断日: 30 日前 (窓の外) / 16・15 日前 (対象) / 10 日前 (まだ早い)
    for (const daysAgo of [30, 16, 15, 10]) {
      createdAt = 100 * DAY - daysAgo * DAY;
      cards.create(input());
    }
    now = 100 * DAY;
    followups = new OutcomeFollowupRepository(database, { clock: () => now });
    outcomes = new CardOutcomeService(cards, new CardOutcomeRepository(database, { clock: () => now }));
    posted = [];
    replies = [];
    warnings = [];
  });

  afterEach(() => database.close());

  it("asks once per due card and records the decider's reply as an outcome", async () => {
    const first = await relay().run();
    const [due1, due2] = [`card-${id - 2}`, `card-${id - 1}`];

    expect(first).toEqual({ asked: 2, recorded: 0 });
    expect(posted[0]).toContain(due1);
    expect(posted[1]).toContain(due2);

    replies = [
      reply(101, "不一致\n1 週間遅れた\n採用: レビューを待った"),
      reply(102, "一致 そのまま出せた", "someone-else"),
      reply(555, "一致 unrelated message"),
    ];
    const second = await relay().run();

    expect(second).toEqual({ asked: 0, recorded: 1 });
    expect(outcomes.get(due1)).toMatchObject({
      verdict: "mismatch",
      adoptedDecision: "レビューを待った",
      actualResult: "1 週間遅れた",
      recordedBy: DECIDER,
      recordedVia: "discord",
    });
    expect(outcomes.get(due2)).toBeNull();
    expect(warnings.some((message) => message.includes("non-decider"))).toBe(true);
    // 回答済みは再度取り込まない。訊いたカードは二度と訊かない。
    replies = [reply(101, "一致 上書きしない")];
    expect(await relay().run()).toEqual({ asked: 0, recorded: 0 });
    expect(outcomes.get(due1)?.verdict).toBe("mismatch");
  });

  it("leaves unreadable replies open so a corrected reply is picked up later", async () => {
    await relay().run();
    const due1 = `card-${id - 2}`;
    replies = [reply(101, "たぶん良かった")];
    expect((await relay().run()).recorded).toBe(0);
    expect(warnings.some((message) => message.includes("could not read"))).toBe(true);

    replies = [reply(101, "一致\n問題なし")];
    expect((await relay().run()).recorded).toBe(1);
    expect(outcomes.get(due1)?.verdict).toBe("match");
  });

  it("does not ask about cards that already have an outcome, and ingests nothing without a decider", async () => {
    outcomes.record(`card-${id - 2}`, {
      adoptedDecision: "a",
      actualResult: "r",
      verdict: "match",
      recordedBy: "neco",
    }, "api");

    const result = await relay(null).run();

    expect(result).toEqual({ asked: 1, recorded: 0 });
    expect(warnings.some((message) => message.includes("deciderDiscordUserId is unset"))).toBe(true);
  });

  it("is run by the ingest hook independently of the question relay", async () => {
    const run = vi.fn(async () => ({ asked: 1, recorded: 1 }));
    const messages: string[] = [];
    const hook = new IngestQuestionHook({
      questions: {
        generate: async () => ({ created: [], skipped: 0, openCount: 0 }),
      } as unknown as QuestionGenerationService,
      relay: { run: async () => { throw new Error("question relay down"); } },
      outcomeFollowups: { run },
      warningSink: (message) => messages.push(message),
    });

    await hook.onRunCompleted();

    expect(run).toHaveBeenCalledTimes(1);
    expect(messages).toContain("[outcome] follow-ups: asked 1, recorded 1");
  });
});
