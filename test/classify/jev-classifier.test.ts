import { describe, expect, it } from "vitest";
import type { ChoiceRequest, NoulRequest } from "../../src/classify/classifier.js";
import { JevClassifier } from "../../src/classify/jev-classifier.js";

interface Capture {
  url: string;
  body: Record<string, unknown>;
}

/**
 * SDK は応答本文をそのまま返す (`dist/index.mjs` の `#request`) ので、
 * `fetch` を差し替えればネットワークを張らずに往復を再現できる。
 */
function classifierReturning(
  answer: unknown,
  captures: Capture[] = [],
): JevClassifier {
  return new JevClassifier({
    apiKey: "test-key",
    model: null,
    baseUrl: "https://api.example.invalid",
    timeoutMs: 1_000,
    fetch: async (url, init) => {
      captures.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          model: "jev-latest",
          answers: { answer },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
}

function noulRequest(overrides: Partial<NoulRequest> = {}): NoulRequest {
  return {
    purpose: "contradiction-check",
    instructions: "Are these incompatible?",
    evidence: { left: "a", right: "b" },
    disclosure: "public",
    threshold: 0.6,
    ...overrides,
  };
}

function choiceRequest(overrides: Partial<ChoiceRequest> = {}): ChoiceRequest {
  return {
    purpose: "categorize",
    instructions: "Pick a category.",
    evidence: { situation: "a" },
    labels: { workflow: "process decisions", "impl-design": "code structure" },
    disclosure: "public",
    ...overrides,
  };
}

describe("JevClassifier", () => {
  it("refuses to send local-only evidence", async () => {
    const captures: Capture[] = [];
    const classifier = classifierReturning({ type: "noul", noul: 1 }, captures);

    await expect(classifier.noul(noulRequest({ disclosure: "local-only" }))).rejects.toThrow(
      /must not be sent to an external classifier/,
    );
    await expect(classifier.choice(choiceRequest({ disclosure: "local-only" }))).rejects.toThrow(
      /must not be sent to an external classifier/,
    );
    // 拒否は送信前に行う。1 度も外へ出ていないことを確かめる。
    expect(captures).toHaveLength(0);
  });

  it("thresholds the noul probability and keeps it on the judgment", async () => {
    const above = await classifierReturning({ type: "noul", noul: 0.62 }).noul(noulRequest());
    const below = await classifierReturning({ type: "noul", noul: 0.59 }).noul(noulRequest());

    expect(above).toEqual({ yes: true, probability: 0.62 });
    expect(below).toEqual({ yes: false, probability: 0.59 });
  });

  it("sends the evidence as state, separate from the instructions", async () => {
    const captures: Capture[] = [];
    await classifierReturning({ type: "noul", noul: 1 }, captures).noul(noulRequest());

    expect(captures).toHaveLength(1);
    expect(captures[0]?.url).toBe("https://api.example.invalid/v1/systemone");
    expect(captures[0]?.body.state).toBe(JSON.stringify({ left: "a", right: "b" }));
    const questions = captures[0]?.body.questions as Record<string, { type: string }>;
    expect(questions.answer?.type).toBe("noul");
  });

  it("returns the chosen label with its confidence", async () => {
    const judgment = await classifierReturning({
      type: "choice",
      choice: "workflow",
      confidence: 0.81,
      probabilities: { workflow: 0.81, "impl-design": 0.19 },
    }).choice(choiceRequest());

    expect(judgment).toEqual({ label: "workflow", confidence: 0.81 });
  });

  it("rejects a label outside the vocabulary instead of coercing it", async () => {
    const classifier = classifierReturning({
      type: "choice",
      choice: "not-a-category",
      confidence: 0.9,
      probabilities: { "not-a-category": 0.9 },
    });

    await expect(classifier.choice(choiceRequest())).rejects.toThrow(/outside the vocabulary/);
  });

  it("rejects a noul value that is not a probability", async () => {
    const classifier = classifierReturning({ type: "noul", noul: 42 });

    await expect(classifier.noul(noulRequest())).rejects.toThrow(/non-probability noul/);
  });
});
