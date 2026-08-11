import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRepository } from "../src/cards/index.js";
import type { GeniusDatabase } from "../src/db/database.js";
import { openDatabase, runMigrations } from "../src/db/index.js";
import type { CreateCardInput } from "../src/domain/card.js";
import { EMPTY_CARD_FEEDBACK_SUMMARY } from "../src/domain/feedback.js";
import { shouldArchive } from "../src/feedback/archive-policy.js";
import { CardFeedbackRepository } from "../src/feedback/feedback-repository.js";
import {
  CardFeedbackNotAllowedError,
  CardFeedbackService,
  CardNotFoundError,
} from "../src/feedback/feedback-service.js";

function input(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
  return {
    domain: "work",
    visibility: "public",
    category: null,
    situation: "A retrieved card has to be judged after use",
    judgment: "Report the outcome so bad cards stop being selected",
    rationale: "Only the caller knows whether the judgment worked",
    tags: ["feedback"],
    confidence: 0.9,
    sourceRef: "memory:fixture.md#feedback",
    sourceTier: 1,
    ...overrides,
  };
}

describe("archive policy", () => {
  it("never archives on not-in-case alone, however many arrive", () => {
    expect(
      shouldArchive({ ...EMPTY_CARD_FEEDBACK_SUMMARY, notInCase: 50 }),
    ).toBe(false);
  });

  it("needs both the minimum count and the ratio", () => {
    // 比率は足りるが件数が足りない
    expect(shouldArchive({ great: 0, good: 0, poor: 2, notInCase: 0 })).toBe(false);
    // 件数は足りるが比率が足りない
    expect(shouldArchive({ great: 5, good: 5, poor: 3, notInCase: 0 })).toBe(false);
    expect(shouldArchive({ great: 0, good: 1, poor: 3, notInCase: 0 })).toBe(true);
  });

  it("ignores not-in-case in the denominator", () => {
    // not-in-case を分母に入れると 3/13 で閾値を下回り、落ちなくなってしまう。
    expect(shouldArchive({ great: 0, good: 1, poor: 3, notInCase: 9 })).toBe(true);
  });

  it("rejects thresholds that would archive on the first poor", () => {
    expect(() =>
      shouldArchive({ great: 0, good: 0, poor: 1, notInCase: 0 }, { minimumPoor: 0, poorRatio: 0.5 }),
    ).toThrow(/minimumPoor/);
    expect(() =>
      shouldArchive({ great: 0, good: 0, poor: 1, notInCase: 0 }, { minimumPoor: 1, poorRatio: 0 }),
    ).toThrow(/poorRatio/);
  });
});

describe("CardFeedbackService", () => {
  let database: GeniusDatabase;
  let cards: CardRepository;
  let service: CardFeedbackService;
  let feedback: CardFeedbackRepository;
  let id = 0;
  let now = 1_000;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    cards = new CardRepository(database, {
      idFactory: () => `card-${++id}`,
      clock: () => ++now,
    });
    feedback = new CardFeedbackRepository(database, {
      idFactory: () => `feedback-${++id}`,
      clock: () => ++now,
    });
    service = new CardFeedbackService({ database, cards, feedback });
  });

  afterEach(() => database.close());

  it("counts every rating in the summary", () => {
    const card = cards.create(input());
    service.record(card.id, { rating: "great" });
    service.record(card.id, { rating: "good" });
    service.record(card.id, { rating: "not-in-case" });

    expect(service.summary(card.id)).toEqual({ great: 1, good: 1, poor: 0, notInCase: 1 });
  });

  it("archives a card once poor passes the threshold and takes it out of the active set", () => {
    const card = cards.create(input());
    expect(service.record(card.id, { rating: "poor" }).archived).toBe(false);
    expect(service.record(card.id, { rating: "poor" }).archived).toBe(false);
    const third = service.record(card.id, { rating: "poor" });

    expect(third.archived).toBe(true);
    expect(cards.getById(card.id)?.retiredAt).not.toBeNull();
    // 検索・一覧・公開 export が見る active 集合から外れる。
    expect(cards.count()).toBe(0);
    expect(
      database
        .prepare("SELECT changed_fields, changed_by FROM clone_card_revisions WHERE card_id = ?")
        .get(card.id),
    ).toEqual({
      changed_fields: '["retired_at","retired_reason"]',
      changed_by: "api",
    });
  });

  it("does not archive a card that is mostly praised", () => {
    const card = cards.create(input());
    for (const rating of ["great", "great", "good", "good", "good", "good"] as const) {
      service.record(card.id, { rating });
    }
    const result = service.record(card.id, { rating: "poor" });

    expect(result.archived).toBe(false);
    expect(cards.getById(card.id)?.retiredAt).toBeNull();
  });

  it("never archives on not-in-case", () => {
    const card = cards.create(input());
    for (let index = 0; index < 20; index += 1) {
      expect(service.record(card.id, { rating: "not-in-case" }).archived).toBe(false);
    }
    expect(cards.getById(card.id)?.retiredAt).toBeNull();
  });

  it("does not re-archive from feedback that predates a manual un-retire", () => {
    const card = cards.create(input());
    service.record(card.id, { rating: "poor" });
    service.record(card.id, { rating: "poor" });
    expect(service.record(card.id, { rating: "poor" }).archived).toBe(true);

    // 人が戻す (CardService.patch と同じ 2 手: retire 解除 + 抑止時刻の更新)。
    cards.update(card.id, { retired: false });
    cards.clearFeedbackArchive(card.id);

    // 解除前の poor 3 件は数えないので、次の 1 件では落ちない。
    const afterReactivation = service.record(card.id, { rating: "poor" });
    expect(afterReactivation.archived).toBe(false);
    expect(cards.getById(card.id)?.retiredAt).toBeNull();
    // 表示用の集計は全期間のままなので、履歴は失われていない。
    expect(afterReactivation.summary.poor).toBe(4);
  });

  it("counts feedback recorded in the same millisecond after un-retire", () => {
    const fixedNow = 5_000;
    const sameMsCards = new CardRepository(database, {
      idFactory: () => `same-ms-card-${++id}`,
      clock: () => fixedNow,
    });
    const sameMsFeedback = new CardFeedbackRepository(database, {
      idFactory: () => `same-ms-feedback-${++id}`,
      clock: () => fixedNow,
    });
    const sameMsService = new CardFeedbackService({
      database,
      cards: sameMsCards,
      feedback: sameMsFeedback,
    });
    const card = sameMsCards.create(input({ sourceRef: "memory:fixture.md#same-ms" }));
    for (const _ of [0, 1, 2]) sameMsService.record(card.id, { rating: "poor" });
    sameMsCards.update(card.id, { retired: false });
    sameMsCards.clearFeedbackArchive(card.id);

    expect(sameMsService.record(card.id, { rating: "poor" }).archived).toBe(false);
    expect(sameMsService.record(card.id, { rating: "poor" }).archived).toBe(false);
    expect(sameMsService.record(card.id, { rating: "poor" }).archived).toBe(true);
  });

  it("keeps a human retirement timestamp instead of overwriting it", () => {
    const card = cards.create(input());
    const retired = cards.update(card.id, { retired: true });
    for (const _ of [0, 1, 2]) service.record(card.id, { rating: "poor" });

    expect(cards.getById(card.id)?.retiredAt).toBe(retired.retiredAt);
  });

  it("rejects feedback for an unknown card", () => {
    expect(() => service.record("missing", { rating: "poor" })).toThrow(CardNotFoundError);
  });

  it("rejects public-only callers that send a sensitive card id", () => {
    const card = cards.create(input({ visibility: "sensitive", sourceRef: "memory:f.md#s" }));

    expect(() => service.record(card.id, { rating: "poor" }, { publicOnly: true })).toThrow(
      CardFeedbackNotAllowedError,
    );
    expect(service.summary(card.id)).toEqual(EMPTY_CARD_FEEDBACK_SUMMARY);
  });

  it("reads several cards' summaries in one query", () => {
    const first = cards.create(input());
    const second = cards.create(input({ sourceRef: "memory:fixture.md#second" }));
    service.record(first.id, { rating: "great" });
    service.record(second.id, { rating: "poor" });

    const summaries = service.summaries([first.id, second.id]);

    expect(summaries.get(first.id)?.great).toBe(1);
    expect(summaries.get(second.id)?.poor).toBe(1);
  });

  it("rejects a rating outside the controlled vocabulary", () => {
    const card = cards.create(input());

    expect(() =>
      service.record(card.id, { rating: "terrible" as never }),
    ).toThrow();
    expect(service.summary(card.id)).toEqual(EMPTY_CARD_FEEDBACK_SUMMARY);
  });
});
