import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRepository } from "../../src/cards/index.js";
import type { ChoiceRequest, Classifier } from "../../src/classify/classifier.js";
import type { GeniusDatabase } from "../../src/db/database.js";
import { openDatabase, runMigrations } from "../../src/db/index.js";
import type { CreateCardInput } from "../../src/domain/card.js";
import { JUDGMENT_SEATS, type SeatProposal } from "../../src/domain/seat.js";
import { planSeatDecision } from "../../src/seats/seat-decision.js";
import { seatClassifierLabels, toProposedSeat } from "../../src/seats/seat-label.js";
import {
  SeatDecisionConflictError,
  SeatProposalService,
} from "../../src/seats/seat-proposal-service.js";
import { SeatRepository } from "../../src/seats/seat-repository.js";

let refSeq = 0;

function input(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
  return {
    domain: "work",
    visibility: "public",
    category: null,
    situation: "Choosing how to roll back a failed deploy",
    judgment: "Roll back first, investigate later",
    rationale: "Recovery time matters more than root cause",
    tags: [],
    confidence: 0.8,
    sourceRef: `memory:fixture.md#seat-${++refSeq}`,
    sourceTier: 1,
    ...overrides,
  };
}

function proposal(overrides: Partial<SeatProposal> = {}): SeatProposal {
  return {
    cardId: "c1",
    proposedSeat: "devops",
    confidence: 1,
    status: "proposed",
    decidedSeat: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("seat vocabulary", () => {
  it("offers the 9 seats plus none to the classifier", () => {
    expect(JUDGMENT_SEATS).toHaveLength(9);
    expect(Object.keys(seatClassifierLabels())).toEqual([...JUDGMENT_SEATS, "none"]);
  });

  it("maps none to no seat and refuses labels outside the vocabulary", () => {
    expect(toProposedSeat("none")).toBeNull();
    expect(toProposedSeat("po")).toBe("po");
    expect(() => toProposedSeat("ceo")).toThrow();
  });
});

describe("planSeatDecision", () => {
  it("confirms as proposed, with an override, or as no seat", () => {
    expect(planSeatDecision(proposal(), { action: "confirm", decidedBy: "neco" })).toEqual({
      ok: true,
      status: "confirmed",
      decidedSeat: "devops",
      cardSeat: "devops",
    });
    expect(planSeatDecision(proposal(), { action: "confirm", seat: "pm", decidedBy: "neco" }))
      .toMatchObject({ cardSeat: "pm" });
    expect(planSeatDecision(proposal(), { action: "confirm", seat: null, decidedBy: "neco" }))
      .toMatchObject({ status: "confirmed", cardSeat: null });
  });

  it("rejects without tagging and never overwrites a decided proposal", () => {
    expect(planSeatDecision(proposal(), { action: "reject", decidedBy: "neco" })).toEqual({
      ok: true,
      status: "rejected",
      decidedSeat: null,
      cardSeat: null,
    });
    expect(planSeatDecision(proposal({ status: "confirmed" }), { action: "reject", decidedBy: "x" }))
      .toMatchObject({ ok: false });
  });
});

describe("SeatProposalService", () => {
  let database: GeniusDatabase;
  let cards: CardRepository;
  let seats: SeatRepository;
  let requests: ChoiceRequest[];
  let labels: string[];
  let id = 0;
  let now = 1_000;

  const classifier: Classifier = {
    async noul() { throw new Error("unused"); },
    async choice(request) {
      requests.push(request);
      const label = labels.shift();
      if (label === undefined) throw new Error("backend down");
      return { label, confidence: 0.7 };
    },
  };

  function service(withClassifier: Classifier | null = classifier): SeatProposalService {
    return new SeatProposalService({ seats, cards, classifier: withClassifier });
  }

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    cards = new CardRepository(database, { idFactory: () => `card-${++id}`, clock: () => ++now });
    seats = new SeatRepository(database, { clock: () => ++now });
    requests = [];
    labels = [];
  });

  afterEach(() => database.close());

  it("proposes once per active card, keeps sensitive text local and isolates failures", async () => {
    const pub = cards.create(input());
    const sensitive = cards.create(input({ visibility: "sensitive" }));
    const failing = cards.create(input());
    const retired = cards.create(input());
    cards.update(retired.id, { retired: true });
    labels = ["devops", "none"];

    const result = await service().generate(10);

    expect(result).toEqual({ scanned: 3, proposed: 2, failed: 1 });
    expect(requests.map((request) => request.disclosure)).toEqual(["public", "local-only", "public"]);
    expect(requests[0]?.purpose).toBe("seat-classify");
    expect(seats.getProposal(pub.id)).toMatchObject({ proposedSeat: "devops", confidence: 0.7 });
    expect(seats.getProposal(sensitive.id)).toMatchObject({ proposedSeat: null });
    expect(seats.getProposal(failing.id)).toBeNull();
    expect(seats.getSeat(pub.id)).toBeNull();

    labels = ["quality"];
    expect(await service().generate(10)).toEqual({ scanned: 1, proposed: 1, failed: 0 });
  });

  it("tags the card only when a human confirms and reports coverage", async () => {
    const card = cards.create(input());
    const other = cards.create(input());
    labels = ["devops", "none"];
    await service().generate(10);

    const confirmed = service().decide(card.id, { action: "confirm", decidedBy: "neco" });
    service().decide(other.id, { action: "confirm", decidedBy: "neco" });

    expect(confirmed).toMatchObject({ status: "confirmed", decidedSeat: "devops", decidedBy: "neco" });
    expect(seats.getSeat(card.id)).toMatchObject({ seat: "devops", confirmedBy: "neco" });
    expect(seats.seatsOf([card.id, other.id])).toEqual(new Map([[card.id, "devops"]]));
    expect(service().coverage()).toEqual({
      activeCards: 2,
      seated: 1,
      confirmedNoSeat: 1,
      pendingProposals: 0,
    });
    expect(() => service().decide(card.id, { action: "reject", decidedBy: "neco" }))
      .toThrow(SeatDecisionConflictError);
  });

  it("needs a classifier to generate and a proposal to decide", async () => {
    const card = cards.create(input());
    await expect(service(null).generate(1)).rejects.toThrow(/classifier/);
    expect(() => service().decide(card.id, { action: "confirm", decidedBy: "neco" }))
      .toThrow(SeatDecisionConflictError);
    expect(service().list("proposed", 10, 0)).toEqual([]);
  });
});
