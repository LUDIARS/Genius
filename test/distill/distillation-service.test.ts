import { describe, expect, it } from "vitest";
import type { CloneCard, CreateCardInput, DistilledCard } from "../../src/domain/card.js";
import type { DistillationCardGateway } from "../../src/distill/distillation-service.js";
import { DistillationService } from "../../src/distill/distillation-service.js";
import type { DistillCompletionRequest, DistillLlm } from "../../src/distill/distill-llm.js";
import { LlmPublicCardGate } from "../../src/distill/public-card-gate.js";
import type { SourceDocument } from "../../src/readers/source-reader.js";

class QueueLlm implements DistillLlm {
  readonly requests: DistillCompletionRequest[] = [];
  readonly #responses: string[];

  constructor(responses: string[]) {
    this.#responses = [...responses];
  }

  async assertReady(): Promise<void> {}

  async complete(request: DistillCompletionRequest): Promise<string> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("Fake LLM response queue exhausted");
    return response;
  }
}

class FakeCardGateway implements DistillationCardGateway {
  readonly saved: CreateCardInput[] = [];
  readonly cards: CloneCard[] = [];
  readonly superseded: Array<{ cardId: string; replacementId: string }> = [];
  readonly #bySourceRef = new Map<string, CloneCard>();
  duplicate: CloneCard | null = null;

  async findBySourceRef(sourceRef: string): Promise<CloneCard | null> {
    return this.#bySourceRef.get(sourceRef) ?? null;
  }

  async findDuplicate(): Promise<CloneCard | null> {
    return this.duplicate;
  }

  async saveChecked(input: CreateCardInput): Promise<CloneCard> {
    const existing = this.#bySourceRef.get(input.sourceRef);
    if (existing) return existing;
    this.saved.push(input);
    const card = {
      ...input,
      id: `01TEST${this.saved.length}`,
      decidedBy: input.decidedBy ?? null,
      supersededBy: null,
      retiredAt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    this.cards.push(card);
    this.#bySourceRef.set(input.sourceRef, card);
    return card;
  }

  async replaceChecked(input: CreateCardInput, cardId: string): Promise<CloneCard> {
    const replacement = await this.saveChecked(input);
    const replacementId = replacement.id;
    this.superseded.push({ cardId, replacementId });
    return replacement;
  }
}

describe("DistillationService", () => {
  it("validates cards and downgrades a public card when the second check flags it", async () => {
    const llm = new QueueLlm([
      JSON.stringify({ cards: [card({ visibility: "public" })] }),
      JSON.stringify({ sensitive: true, reason: "private context" }),
    ]);
    const gateway = new FakeCardGateway();
    const service = createService(gateway, llm);

    const result = await service.distill(document());

    expect(result).toEqual({ cardsCreated: 1, cardsMerged: 0 });
    expect(gateway.saved[0]?.visibility).toBe("sensitive");
    expect(gateway.saved[0]?.sourceRef).toMatch(
      /^memory:fixture\.md#card-sha256-[a-f0-9]{64}$/,
    );
    expect(llm.requests.map((request) => request.purpose)).toEqual(["cards", "sensitive-check"]);
    expect(llm.requests[0]?.systemPrompt).toContain("untrusted document data");
    expect(llm.requests[0]?.systemPrompt).not.toContain("A choice and its rationale");
    expect(llm.requests[0]?.prompt).toBe("A choice and its rationale");
  });

  it("merges a same-quadrant duplicate and supersedes the previous card", async () => {
    const incoming = card({ visibility: "sensitive" });
    const merged = card({ visibility: "sensitive", judgment: "Prefer the reversible option" });
    const llm = new QueueLlm([
      JSON.stringify({ cards: [incoming] }),
      JSON.stringify({ merge: true, card: merged }),
    ]);
    const gateway = new FakeCardGateway();
    gateway.duplicate = cloneCard(incoming, "01OLD");
    const service = createService(gateway, llm);

    const result = await service.distill(document());

    expect(result).toEqual({ cardsCreated: 1, cardsMerged: 1 });
    expect(gateway.saved[0]?.judgment).toBe("Prefer the reversible option");
    expect(gateway.superseded).toEqual([{ cardId: "01OLD", replacementId: "01TEST1" }]);
    const mergeRequest = llm.requests.find((request) => request.purpose === "merge-check");
    expect(mergeRequest?.systemPrompt).toContain("untrusted card data");
    expect(mergeRequest?.systemPrompt).not.toContain("Choose the path with explicit failure modes");
    expect(mergeRequest?.prompt).toBeTypeOf("string");
    expect(mergeRequest?.prompt).toContain("Choose the path with explicit failure modes");
    expect(mergeRequest?.prompt).not.toContain("Prefer the reversible option");
  });

  it("checks merged public content again before persistence", async () => {
    const incoming = card({ visibility: "public" });
    const merged = card({ visibility: "public", rationale: "Contains newly merged private context" });
    const llm = new QueueLlm([
      JSON.stringify({ cards: [incoming] }),
      JSON.stringify({ sensitive: false }),
      JSON.stringify({ merge: true, card: merged }),
      JSON.stringify({ sensitive: true, reason: "merged content is private" }),
    ]);
    const gateway = new FakeCardGateway();
    gateway.duplicate = cloneCard(incoming, "01OLD");

    const result = await createService(gateway, llm).distill(document());

    expect(result).toEqual({ cardsCreated: 1, cardsMerged: 1 });
    expect(gateway.saved[0]?.visibility).toBe("sensitive");
    expect(llm.requests.map((request) => request.purpose)).toEqual([
      "cards",
      "sensitive-check",
      "merge-check",
      "sensitive-check",
    ]);
  });

  it("keeps a distinct incoming card when the duplicate candidate is not mergeable", async () => {
    const incoming = card({ visibility: "sensitive" });
    const llm = new QueueLlm([
      JSON.stringify({ cards: [incoming] }),
      JSON.stringify({ merge: false }),
    ]);
    const gateway = new FakeCardGateway();
    gateway.duplicate = cloneCard(incoming, "01OLD");

    const result = await createService(gateway, llm).distill(document());

    expect(result).toEqual({ cardsCreated: 1, cardsMerged: 0 });
    expect(gateway.saved).toHaveLength(1);
    expect(gateway.superseded).toHaveLength(0);
  });

  it("uses content anchors so unchanged retries and card reordering are idempotent", async () => {
    const first = card({ visibility: "sensitive", judgment: "Prefer explicit contracts" });
    const second = card({ visibility: "sensitive", judgment: "Prefer reversible changes" });
    const llm = new QueueLlm([
      JSON.stringify({ cards: [first, second] }),
      JSON.stringify({ cards: [second, first] }),
    ]);
    const gateway = new FakeCardGateway();
    const service = createService(gateway, llm);

    await expect(service.distill(document())).resolves.toEqual({
      cardsCreated: 2,
      cardsMerged: 0,
    });
    const initialSourceRefs = gateway.saved.map((saved) => saved.sourceRef).sort();
    await expect(service.distill(document())).resolves.toEqual({
      cardsCreated: 0,
      cardsMerged: 0,
    });

    expect(gateway.saved).toHaveLength(2);
    expect(gateway.saved.map((saved) => saved.sourceRef).sort()).toEqual(initialSourceRefs);
    expect(new Set(initialSourceRefs).size).toBe(2);
  });

  it("creates a new content anchor and supersedes a mergeable changed card", async () => {
    const original = card({
      visibility: "sensitive",
      rationale: "It keeps failures observable",
    });
    const changed = card({
      visibility: "sensitive",
      rationale: "It keeps failures observable and recovery explicit",
    });
    const merged = card({
      visibility: "sensitive",
      rationale: "It preserves observable failures and explicit recovery",
    });
    const llm = new QueueLlm([
      JSON.stringify({ cards: [original] }),
      JSON.stringify({ cards: [changed] }),
      JSON.stringify({ merge: true, card: merged }),
    ]);
    const gateway = new FakeCardGateway();
    const service = createService(gateway, llm);

    await expect(service.distill(document())).resolves.toEqual({
      cardsCreated: 1,
      cardsMerged: 0,
    });
    gateway.duplicate = gateway.cards[0] ?? null;
    await expect(service.distill(document())).resolves.toEqual({
      cardsCreated: 1,
      cardsMerged: 1,
    });

    expect(gateway.saved).toHaveLength(2);
    expect(gateway.saved[0]?.sourceRef).not.toBe(gateway.saved[1]?.sourceRef);
    expect(gateway.superseded).toEqual([{ cardId: "01TEST1", replacementId: "01TEST2" }]);
  });

  it("retries invalid JSON twice and then fails explicitly", async () => {
    const llm = new QueueLlm(["not-json", "still-not-json", "[]"]);
    const service = createService(new FakeCardGateway(), llm);

    await expect(service.distill(document())).rejects.toThrow("after 3 attempts");
    expect(llm.requests).toHaveLength(3);
  });

  it("persists a category chosen from the controlled vocabulary", async () => {
    const llm = new QueueLlm([
      JSON.stringify({ cards: [card({ visibility: "sensitive", category: "review" })] }),
    ]);
    const gateway = new FakeCardGateway();

    await createService(gateway, llm).distill(document());

    expect(gateway.saved[0]?.category).toBe("review");
  });

  it("rejects a category outside the controlled vocabulary instead of coercing it", async () => {
    const offVocabulary = JSON.stringify({
      cards: [card({ visibility: "sensitive", category: "not-a-real-category" })],
    });
    const llm = new QueueLlm([offVocabulary, offVocabulary, offVocabulary]);
    const gateway = new FakeCardGateway();

    await expect(createService(gateway, llm).distill(document())).rejects.toThrow(
      "after 3 attempts",
    );
    expect(gateway.saved).toHaveLength(0);
  });

  it("rejects a card with a missing category", async () => {
    const { category: _category, ...withoutCategory } = card({ visibility: "sensitive" });
    const payload = JSON.stringify({ cards: [withoutCategory] });
    const llm = new QueueLlm([payload, payload, payload]);
    const gateway = new FakeCardGateway();

    await expect(createService(gateway, llm).distill(document())).rejects.toThrow(
      "after 3 attempts",
    );
    expect(gateway.saved).toHaveLength(0);
  });
});

const TEST_CATEGORY_NAMES = ["impl-design", "review", "general"] as const;

function createService(gateway: FakeCardGateway, llm: DistillLlm): DistillationService {
  return new DistillationService({
    cardGateway: gateway,
    categoryNames: [...TEST_CATEGORY_NAMES],
    llm,
    prompt: "extract",
    publicCardGate: new LlmPublicCardGate(llm),
  });
}

function card(overrides: Partial<DistilledCard> = {}): DistilledCard {
  return {
    domain: "work",
    visibility: "public",
    category: "impl-design",
    situation: "When two implementation paths are viable",
    judgment: "Choose the path with explicit failure modes",
    rationale: "It keeps defects observable",
    tags: ["design"],
    confidence: 0.9,
    ...overrides,
  };
}

function cloneCard(value: DistilledCard, id: string): CloneCard {
  return {
    ...value,
    id,
    sourceRef: "memory:old.md#card-001",
    sourceTier: 1,
    decidedBy: null,
    supersededBy: null,
    retiredAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function document(): SourceDocument {
  return {
    descriptor: {
      source: "memory",
      tier: 1,
      locator: "fixture.md",
      mtimeMs: 1,
      sizeBytes: 10,
    },
    sourceRef: "memory:fixture.md",
    title: "Fixture",
    content: "A choice and its rationale",
    metadata: {},
  };
}
