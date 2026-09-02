import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { openDatabase, type GeniusDatabase } from "../../src/db/database.js";
import type { DistillCompletionRequest, DistillLlm } from "../../src/distill/distill-llm.js";
import type { PublicCardGate } from "../../src/distill/public-card-gate.js";
import type { DistilledCard } from "../../src/domain/card.js";
import type { EmbeddingClient } from "../../src/embedding/types.js";
import { ContradictionDetector } from "../../src/questions/contradiction-detector.js";
import { GapRepository } from "../../src/questions/gap-repository.js";
import { QuestionGenerationService } from "../../src/questions/question-generation-service.js";
import { QuestionRepository } from "../../src/questions/question-repository.js";

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

class EchoQuestionLlm implements DistillLlm {
  readonly requests: DistillCompletionRequest[] = [];

  async assertReady(): Promise<void> {}

  async complete(request: DistillCompletionRequest): Promise<string> {
    this.requests.push(request);
    if (request.purpose === "contradiction-check") {
      return JSON.stringify({ contradiction: true, reason: "opposite instructions" });
    }
    if (request.purpose !== "question-generation" || typeof request.prompt !== "string") {
      throw new Error(`Unexpected purpose: ${request.purpose}`);
    }
    const decoded = JSON.parse(request.prompt) as { control: Record<string, unknown> };
    return JSON.stringify({
      question: "この場面では、どの判断を採用しますか？",
      context: "既存カードでは判断を確定できません。",
      ...decoded.control,
    });
  }
}

class DowngradingGate implements PublicCardGate {
  async check(card: DistilledCard): Promise<DistilledCard> {
    return { ...card, visibility: "sensitive" };
  }
}

describe("active questioning Q3+Q4", () => {
  it("prioritizes retrieval misses, applies the public gate, and obeys both caps", async () => {
    const db = database();
    db.prepare(
      `INSERT INTO query_log(
         id, text, domain, visibility, categories, top_similarity, result_count, created_at
       ) VALUES ('LOG1', 'How should this be decided?', 'work', 'public', '["review"]', 0.2, 1, 10)`,
    ).run();
    insertCard(db, {
      id: "CARD1",
      category: "impl-design",
      confidence: 0.1,
      situation: "Low-confidence situation",
      judgment: "Tentative choice",
    });
    let nextId = 0;
    const questions = new QuestionRepository(db, {
      clock: () => 100,
      idFactory: () => `ID${++nextId}`,
    });
    const llm = new EchoQuestionLlm();
    const service = new QuestionGenerationService({
      config: {
        enabled: true,
        maxPerRun: 1,
        maxOpen: 1,
        deciderDiscordUserId: null,
        lowConfidenceBelow: 0.5,
        retrievalMissBelow: 0.5,
        discordEnabled: true,
      },
      contradictions: { detect: async () => [] },
      gaps: new GapRepository(db),
      llm,
      publicCardGate: new DowngradingGate(),
      questions,
    });

    const first = await service.generate();
    const second = await service.generate();

    expect(first.created).toHaveLength(1);
    expect(first.created[0]).toMatchObject({
      gapKind: "retrieval-miss",
      category: "review",
      visibility: "sensitive",
    });
    expect(first.created[0]?.targets).toEqual([{ kind: "query_log", id: "LOG1" }]);
    expect(second.created).toEqual([]);
    expect(second.openCount).toBe(1);
    expect(llm.requests.map((request) => request.purpose)).toEqual(["question-generation"]);
  });

  it("uses situation-only neighbors and judgment-only similarity before LLM confirmation", async () => {
    const db = database();
    insertCard(db, {
      id: "CARD1",
      category: "review",
      confidence: 0.9,
      situation: "same situation one",
      judgment: "always choose A",
    });
    insertCard(db, {
      id: "CARD2",
      category: "review",
      confidence: 0.9,
      situation: "same situation two",
      judgment: "never choose A",
    });
    insertCard(db, {
      id: "CARD3",
      category: "review",
      confidence: 0.9,
      situation: "unrelated situation",
      judgment: "choose C",
    });
    const llm = new EchoQuestionLlm();
    const detector = new ContradictionDetector({
      database: db,
      embedder: new TextEmbeddingClient(),
      gaps: new GapRepository(db),
      llm,
      questions: new QuestionRepository(db),
      situationSimilarityMin: 0.85,
      judgmentSimilarityMax: 0.5,
    });

    const gaps = await detector.detect(5);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.primaryTarget).toEqual({ kind: "card-pair", id: "CARD1:CARD2" });
    expect(gaps[0]?.targets).toEqual([
      { kind: "card-pair", id: "CARD1:CARD2" },
      { kind: "card-context", id: "CARD1" },
      { kind: "card-context", id: "CARD2" },
    ]);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.purpose).toBe("contradiction-check");
  });
});

class TextEmbeddingClient implements EmbeddingClient {
  readonly model = "fake";
  readonly dimension = 1024;

  async assertReady(): Promise<void> {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => vectorFor(text));
  }
}

function vectorFor(text: string): number[] {
  const vector = new Array<number>(1024).fill(0);
  if (text === "same situation one") {
    vector[0] = 1;
  } else if (text === "same situation two") {
    vector[0] = 0.99;
    vector[1] = 0.01;
  } else if (text === "always choose A") {
    vector[0] = 1;
  } else if (text === "never choose A") {
    vector[0] = -1;
  } else {
    vector[1] = 1;
  }
  return vector;
}

function insertCard(
  db: GeniusDatabase,
  input: {
    id: string;
    category: string;
    confidence: number;
    situation: string;
    judgment: string;
  },
): void {
  db.prepare(
    `INSERT INTO clone_cards(
       id, domain, visibility, category, situation, judgment, rationale, tags,
       source_ref, source_tier, confidence, superseded_by, retired_at, created_at, updated_at
     ) VALUES (?, 'work', 'public', ?, ?, ?, 'because', '[]', ?, 1, ?, NULL, NULL, 1, 1)`,
  ).run(
    input.id,
    input.category,
    input.situation,
    input.judgment,
    `fixture:${input.id}`,
    input.confidence,
  );
}
