import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRepository } from "../../src/cards/index.js";
import type { Classifier, NoulRequest } from "../../src/classify/classifier.js";
import type { GeniusDatabase } from "../../src/db/database.js";
import { openDatabase, runMigrations } from "../../src/db/index.js";
import type { CreateCardInput } from "../../src/domain/card.js";
import type { ElegantiaAntipatternInput } from "../../src/elegantia/antipattern-payload.js";
import { ElegantiaRequestError, type ElegantiaAntipatternSink } from "../../src/elegantia/elegantia-client.js";
import { ElegantiaOutbox } from "../../src/elegantia/elegantia-outbox.js";
import { ElegantiaQualityRouter } from "../../src/elegantia/quality-router.js";

let refSeq = 0;

function input(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
  return {
    domain: "work",
    visibility: "public",
    category: null,
    situation: "A list API refetches the whole upstream catalogue on every call",
    judgment: "Cache the upstream list and refresh it in the background",
    rationale: "Per-request upstream fetches push responses past one second",
    tags: [],
    confidence: 0.8,
    sourceRef: `memory:fixture.md#elegantia-${++refSeq}`,
    sourceTier: 1,
    ...overrides,
  };
}

interface OutboxState {
  state: string;
  attempts: number;
  last_error: string | null;
  elegantia_id: string | null;
  probability: number | null;
}

describe("ElegantiaQualityRouter", () => {
  let database: GeniusDatabase;
  let cards: CardRepository;
  let requests: NoulRequest[];
  let answers: Array<number | Error>;
  let sent: ElegantiaAntipatternInput[];
  let sendFailures: number;
  let warnings: string[];
  let id = 0;
  let now = 1_000;

  const classifier: Classifier = {
    async noul(request) {
      requests.push(request);
      const answer = answers.shift();
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error("no answer");
      return { yes: answer >= request.threshold, probability: answer };
    },
    async choice() { throw new Error("unused"); },
  };

  const sink: ElegantiaAntipatternSink = {
    async register(payload) {
      if (sendFailures > 0) {
        sendFailures -= 1;
        throw new ElegantiaRequestError("Elegantia /api/antipatterns answered HTTP 503");
      }
      sent.push(payload);
      return { id: `AP-G-${sent.length}`, created: true };
    },
  };

  function router(): ElegantiaQualityRouter {
    return new ElegantiaQualityRouter({
      cards,
      outbox: new ElegantiaOutbox(database, () => ++now),
      classifier,
      sink,
      threshold: 0.7,
      maxPerRun: 50,
      warningSink: (message) => warnings.push(message),
    });
  }

  function outboxRow(cardId: string): OutboxState | undefined {
    return database
      .prepare<[string], OutboxState>(
        "SELECT state, attempts, last_error, elegantia_id, probability FROM elegantia_outbox WHERE card_id = ?",
      )
      .get(cardId);
  }

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    cards = new CardRepository(database, { idFactory: () => `card-${++id}`, clock: () => ++now });
    requests = [];
    answers = [];
    sent = [];
    sendFailures = 0;
    warnings = [];
  });

  afterEach(() => database.close());

  it("registers quality-standard cards and keeps rejected ones only in Genius", async () => {
    const standard = cards.create(input());
    const personal = cards.create(input({ judgment: "Take Friday off this week" }));
    const route = router();
    route.onCardSaved(standard);
    route.onCardSaved(personal);
    answers = [0.9, 0.2];

    await expect(route.flush()).resolves.toEqual({ registered: 1, failed: 0 });

    expect(requests.map((request) => [request.purpose, request.disclosure])).toEqual([
      ["quality-route", "public"],
      ["quality-route", "public"],
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sourceRef).toBe(`genius:card:${standard.id}`);
    expect(outboxRow(standard.id)).toMatchObject({ state: "sent", elegantia_id: "AP-G-1" });
    expect(outboxRow(personal.id)).toMatchObject({ state: "rejected", probability: 0.2 });
    // Both cards stay in Genius regardless of the routing outcome.
    expect(cards.getById(standard.id)).not.toBeNull();
    expect(cards.getById(personal.id)).not.toBeNull();
    await expect(route.flush()).resolves.toEqual({ registered: 0, failed: 0 });
  });

  it("never classifies or sends sensitive cards", async () => {
    const sensitive = cards.create(input({ visibility: "sensitive" }));
    const route = router();
    route.onCardSaved(sensitive);

    await expect(route.flush()).resolves.toEqual({ registered: 0, failed: 0 });
    expect(requests).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(outboxRow(sensitive.id)).toBeUndefined();
  });

  it("skips a queued card that turned sensitive before the flush", async () => {
    const card = cards.create(input());
    const route = router();
    route.onCardSaved(card);
    cards.update(card.id, { visibility: "sensitive" });

    await expect(route.flush()).resolves.toEqual({ registered: 0, failed: 0 });
    expect(requests).toHaveLength(0);
    expect(outboxRow(card.id)).toMatchObject({ state: "skipped" });
  });

  it("records send failures and resends on the next flush without reclassifying", async () => {
    const card = cards.create(input());
    const route = router();
    route.onCardSaved(card);
    answers = [0.95];
    sendFailures = 1;

    await expect(route.flush()).resolves.toEqual({ registered: 0, failed: 1 });
    expect(outboxRow(card.id)).toMatchObject({
      state: "pending-send",
      attempts: 1,
      last_error: "send: ElegantiaRequestError",
    });
    expect(warnings.join("\n")).toMatch(/HTTP 503/);

    await expect(route.flush()).resolves.toEqual({ registered: 1, failed: 0 });
    expect(requests).toHaveLength(1);
    expect(outboxRow(card.id)).toMatchObject({ state: "sent", last_error: null });
  });

  it("keeps a card pending when classification fails and retries it later", async () => {
    const card = cards.create(input());
    const route = router();
    route.onCardSaved(card);
    answers = [new Error("backend down")];

    await expect(route.flush()).resolves.toEqual({ registered: 0, failed: 1 });
    expect(outboxRow(card.id)).toMatchObject({ state: "pending-classify", attempts: 1 });
    expect(warnings.join("\n")).not.toContain("backend down");

    answers = [0.8];
    await expect(route.flush()).resolves.toEqual({ registered: 1, failed: 0 });
  });

  it("queues a card once even when it is saved again", async () => {
    const card = cards.create(input());
    const route = router();
    route.onCardSaved(card);
    answers = [0.9];
    await route.flush();
    route.onCardSaved(card);

    await expect(route.flush()).resolves.toEqual({ registered: 0, failed: 0 });
    expect(sent).toHaveLength(1);
  });
});
