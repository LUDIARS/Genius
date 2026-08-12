import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import type { ApiServices } from "../../src/api/contracts.js";
import { openDatabase, type GeniusDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { DistillCompletionRequest, DistillLlm } from "../../src/distill/distill-llm.js";
import type { CardPatch, CloneCard } from "../../src/domain/card.js";
import {
  ContradictionWinnerMismatchError,
  ContradictionWinnerRequiredError,
  QuestionAnswerService,
} from "../../src/questions/question-answer-service.js";
import {
  QuestionAnswerPendingError,
  QuestionNotOpenError,
  QuestionQueueRepository,
  splitCardPairId,
} from "../../src/questions/question-queue-repository.js";
import { QuestionRepository } from "../../src/questions/question-repository.js";
import { QuestionQueueService } from "../../src/services/question-queue-service.js";

const databases: GeniusDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function database(): GeniusDatabase {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  return db;
}

class ShapingLlm implements DistillLlm {
  readonly requests: DistillCompletionRequest[] = [];
  failuresRemaining = 0;

  async assertReady(): Promise<void> {}

  async complete(request: DistillCompletionRequest): Promise<string> {
    this.requests.push(request);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("temporary shaping failure");
    }
    if (request.purpose !== "answer-shaping") throw new Error(`Unexpected purpose: ${request.purpose}`);
    return JSON.stringify({
      situation: "The reviewed situation",
      judgment: "The reviewer's decision",
      rationale: "Because the reviewer said so",
      tags: ["interview"],
    });
  }
}

/**
 * Records every write so the tests can assert what the answer path did. The
 * created card is also inserted for real: `question_answers.card_id` is a
 * foreign key, so a card that exists only in the stub would hide a broken link.
 */
class RecordingCards {
  readonly created: Record<string, unknown>[] = [];
  readonly patched: { id: string; patch: CardPatch; changedBy: string }[] = [];
  readonly stored = new Map<string, CloneCard>();
  createFailuresRemaining = 0;
  missingCardIds = new Set<string>();
  readonly #database: GeniusDatabase;

  constructor(db: GeniusDatabase) {
    this.#database = db;
  }

  async list(): Promise<CloneCard[]> { return []; }
  async get(id: string): Promise<CloneCard | null> { return this.stored.get(id) ?? null; }
  async supersedeChain(): Promise<null> { return null; }

  async create(input: Record<string, unknown>): Promise<CloneCard> {
    if (this.createFailuresRemaining > 0) {
      this.createFailuresRemaining -= 1;
      throw new Error("temporary card creation failure");
    }
    this.created.push(input);
    this.#database
      .prepare(
        `INSERT INTO clone_cards(
           id, domain, visibility, category, situation, judgment, rationale, tags,
           source_ref, source_tier, confidence, superseded_by, retired_at, created_at, updated_at
         ) VALUES ('NEWCARD', 'work', 'sensitive', 'review', ?, ?, ?, '[]', ?, 1, 1, NULL, NULL, 1, 1)`,
      )
      .run(
        String(input.situation),
        String(input.judgment),
        String(input.rationale),
        String(input.sourceRef),
      );
    return { ...(input as object), id: "NEWCARD" } as CloneCard;
  }

  async patch(id: string, patch: CardPatch, changedBy: string): Promise<CloneCard | null> {
    this.patched.push({ id, patch, changedBy });
    if (this.missingCardIds.has(id)) return null;
    return { id } as CloneCard;
  }
}

function seedQuestion(
  db: GeniusDatabase,
  overrides: {
    gapKind?: "low-confidence" | "contradiction" | "curation";
    targets?: { kind: "card" | "card-pair" | "card-context"; id: string }[];
  } = {},
): string {
  let next = 0;
  const repository = new QuestionRepository(db, { clock: () => 1, idFactory: () => `Q${++next}` });
  const record = repository.createOpen({
    question: "Which judgment applies here?",
    context: "The corpus disagrees with itself",
    category: "review",
    domain: "work",
    visibility: "sensitive",
    gapKind: overrides.gapKind ?? "low-confidence",
    targets: overrides.targets ?? [{ kind: "card", id: "CARD1" }],
  }, 10);
  return record.id;
}

function serviceFor(db: GeniusDatabase, cards: RecordingCards): {
  queue: QuestionQueueRepository;
  questions: QuestionQueueService;
  llm: ShapingLlm;
} {
  const queue = new QuestionQueueRepository(db);
  const llm = new ShapingLlm();
  const answers = new QuestionAnswerService({
    cards: cards as unknown as ApiServices["cards"],
    llm,
    queue,
  });
  return { queue, questions: new QuestionQueueService(queue, answers), llm };
}

describe("question queue (Q5)", () => {
  it("lists open questions with their answers and pair ids", () => {
    const db = database();
    seedQuestion(db, {
      gapKind: "contradiction",
      targets: [
        { kind: "card-pair", id: "CARDA:CARDB" },
        { kind: "card-context", id: "CARDA" },
        { kind: "card-context", id: "CARDB" },
      ],
    });
    const queue = new QuestionQueueRepository(db);

    const [entry] = queue.list({ status: "open", limit: 50, offset: 0 });

    expect(entry?.gapKind).toBe("contradiction");
    expect(entry?.pairCardIds).toEqual(["CARDA", "CARDB"]);
    expect(entry?.answers).toEqual([]);
    expect(entry?.targets).toHaveLength(3);
  });

  it("refuses a second transition instead of silently ignoring it", () => {
    const db = database();
    const id = seedQuestion(db);
    const queue = new QuestionQueueRepository(db);

    queue.dismiss(id);

    expect(() => queue.dismiss(id)).toThrow(QuestionNotOpenError);
    expect(() => queue.recordAnswer({ questionId: id, text: "late", answeredVia: "ui" }))
      .toThrow(QuestionNotOpenError);
    expect(queue.get(id)?.status).toBe("dismissed");
  });

  it("rejects a non-canonical card-pair id rather than half-reading it", () => {
    expect(() => splitCardPairId("CARDB:CARDA")).toThrow(/not canonical/);
    expect(() => splitCardPairId("CARDA")).toThrow(/Malformed/);
  });
});

describe("answer to card (Q7)", () => {
  it("stores the answer verbatim and creates a card that points back at it", async () => {
    const db = database();
    const cards = new RecordingCards(db);
    const { questions, queue } = serviceFor(db, cards);
    const id = seedQuestion(db);

    const result = await questions.answer({
      questionId: id,
      text: "  We always take the reversible option.  ",
      answeredVia: "ui",
    });

    expect(cards.created).toHaveLength(1);
    expect(cards.created[0]).toMatchObject({
      domain: "work",
      visibility: "sensitive",
      category: "review",
      confidence: 1,
      sourceRef: `interview:${id}#${result.answer.id}`,
      situation: "The reviewed situation",
    });
    // The reviewer's own words survive the shaping step.
    const [stored] = queue.get(id)?.answers ?? [];
    expect(stored?.text).toBe("We always take the reversible option.");
    expect(stored?.cardId).toBe("NEWCARD");
    expect(queue.get(id)?.status).toBe("answered");
    expect(result.supersededCardId).toBeNull();
  });

  it("keeps a failed answer open and retries it with the same answer id", async () => {
    const db = database();
    const cards = new RecordingCards(db);
    const { questions, queue, llm } = serviceFor(db, cards);
    const id = seedQuestion(db);
    llm.failuresRemaining = 1;

    await expect(questions.answer({
      questionId: id,
      text: "Keep the original wording",
      answeredVia: "ui",
    })).rejects.toThrow("temporary shaping failure");

    const pending = queue.get(id);
    expect(pending?.status).toBe("open");
    expect(pending?.answers).toHaveLength(1);
    expect(pending?.answers[0]).toMatchObject({
      text: "Keep the original wording",
      cardId: null,
    });
    await expect(questions.answer({
      questionId: id,
      text: "Replace it silently",
      answeredVia: "ui",
    })).rejects.toThrow(QuestionAnswerPendingError);
    expect(() => queue.dismiss(id)).toThrow(QuestionAnswerPendingError);

    const result = await questions.answer({
      questionId: id,
      text: "Keep the original wording",
      answeredVia: "ui",
    });

    expect(result.answer.id).toBe(pending?.answers[0]?.id);
    expect(result.answer.cardId).toBe("NEWCARD");
    expect(queue.get(id)?.status).toBe("answered");
    expect(queue.get(id)?.answers).toHaveLength(1);
  });

  it("reuses the saved answer when card creation fails after shaping", async () => {
    const db = database();
    const cards = new RecordingCards(db);
    cards.createFailuresRemaining = 1;
    const { questions, queue } = serviceFor(db, cards);
    const id = seedQuestion(db);
    const input = { questionId: id, text: "Retry this answer", answeredVia: "ui" as const };

    await expect(questions.answer(input)).rejects.toThrow("temporary card creation failure");
    const pendingAnswerId = queue.get(id)?.answers[0]?.id;
    expect(queue.get(id)?.status).toBe("open");

    const result = await questions.answer(input);

    expect(result.answer.id).toBe(pendingAnswerId);
    expect(result.answer.cardId).toBe("NEWCARD");
    expect(cards.created).toHaveLength(1);
  });

  it("supersedes the losing card of a contradiction pair", async () => {
    const db = database();
    const cards = new RecordingCards(db);
    const { questions } = serviceFor(db, cards);
    const id = seedQuestion(db, {
      gapKind: "contradiction",
      targets: [
        { kind: "card-pair", id: "CARDA:CARDB" },
        { kind: "card-context", id: "CARDA" },
        { kind: "card-context", id: "CARDB" },
      ],
    });

    const result = await questions.answer({
      questionId: id,
      text: "CARDA is the one we follow.",
      answeredVia: "ui",
      winnerCardId: "CARDA",
    });

    expect(result.supersededCardId).toBe("CARDB");
    expect(cards.patched).toEqual([{
      id: "CARDB",
      patch: { supersededBy: "NEWCARD" },
      changedBy: "ui",
    }]);
  });

  it("refuses a contradiction answer with no winner or a winner outside the pair", async () => {
    const db = database();
    const cards = new RecordingCards(db);
    const { questions } = serviceFor(db, cards);
    const id = seedQuestion(db, {
      gapKind: "contradiction",
      targets: [{ kind: "card-pair", id: "CARDA:CARDB" }],
    });

    await expect(questions.answer({ questionId: id, text: "unsure", answeredVia: "ui" }))
      .rejects.toThrow(ContradictionWinnerRequiredError);
    await expect(questions.answer({
      questionId: id,
      text: "unsure",
      answeredVia: "ui",
      winnerCardId: "CARDZ",
    })).rejects.toThrow(ContradictionWinnerMismatchError);
    // Nothing was written, so the question is still answerable.
    expect(cards.created).toEqual([]);
    expect(new QuestionQueueRepository(db).get(id)?.status).toBe("open");
  });

  it("keeps the question retryable when the losing card has disappeared", async () => {
    const db = database();
    const cards = new RecordingCards(db);
    cards.missingCardIds.add("CARDB");
    const warnings: string[] = [];
    const queue = new QuestionQueueRepository(db);
    const answers = new QuestionAnswerService({
      cards: cards as unknown as ApiServices["cards"],
      llm: new ShapingLlm(),
      queue,
      warningSink: (message) => warnings.push(message),
    });
    const id = seedQuestion(db, {
      gapKind: "contradiction",
      targets: [{ kind: "card-pair", id: "CARDA:CARDB" }],
    });

    await expect(answers.answer({
      questionId: id,
      text: "CARDA wins",
      answeredVia: "ui",
      winnerCardId: "CARDA",
    })).rejects.toThrow("Question supersede target no longer exists: CARDB");

    expect(queue.get(id)?.status).toBe("open");
    expect(queue.get(id)?.answers[0]).toMatchObject({ cardId: null, text: "CARDA wins" });
    expect(warnings.join(" ")).toContain("no longer exists");
  });

  it("replaces the retired target of a curation question", async () => {
    const db = database();
    const cards = new RecordingCards(db);
    cards.stored.set("CARD1", { id: "CARD1", retiredAt: 1 } as CloneCard);
    const { questions } = serviceFor(db, cards);
    const id = seedQuestion(db, { gapKind: "curation" });

    const result = await questions.answer({
      questionId: id,
      text: "Use this replacement judgment",
      answeredVia: "ui",
    });

    expect(result.supersededCardId).toBe("CARD1");
    expect(cards.patched).toEqual([{
      id: "CARD1",
      patch: { supersededBy: "NEWCARD" },
      changedBy: "ui",
    }]);
  });
});

describe("question routes", () => {
  it("answers over HTTP and reports a closed question as a conflict", async () => {
    const db = database();
    const cards = new RecordingCards(db);
    const { questions } = serviceFor(db, cards);
    const app = createApp({ questions } as unknown as ApiServices);
    const id = seedQuestion(db);

    const listed = await app.request("/api/clone/questions?status=open");
    expect(listed.status).toBe(200);
    expect((await listed.json() as { questions: unknown[] }).questions).toHaveLength(1);

    const answered = await app.request(`/api/clone/questions/${id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Take the reversible option" }),
    });
    expect(answered.status).toBe(201);

    const again = await app.request(`/api/clone/questions/${id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Second try" }),
    });
    expect(again.status).toBe(409);

    const missing = await app.request("/api/clone/questions/NOPE/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(404);
  });
});
