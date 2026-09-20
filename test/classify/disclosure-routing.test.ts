import { describe, expect, it } from "vitest";
import type {
  ChoiceJudgment,
  ChoiceRequest,
  Classifier,
  NoulJudgment,
  NoulRequest,
} from "../../src/classify/classifier.js";
import { DisclosureRoutedClassifier } from "../../src/classify/disclosure-routed-classifier.js";

class RecordingClassifier implements Classifier {
  readonly seen: Array<NoulRequest | ChoiceRequest> = [];
  readonly #failure: Error | null;
  readonly #probability: number;
  readonly #label: string;

  constructor(options: { failure?: Error; probability?: number; label?: string } = {}) {
    this.#failure = options.failure ?? null;
    this.#probability = options.probability ?? 1;
    this.#label = options.label ?? "local";
  }

  async noul(request: NoulRequest): Promise<NoulJudgment> {
    this.seen.push(request);
    if (this.#failure !== null) throw this.#failure;
    return { yes: this.#probability >= request.threshold, probability: this.#probability };
  }

  async choice(request: ChoiceRequest): Promise<ChoiceJudgment> {
    this.seen.push(request);
    if (this.#failure !== null) throw this.#failure;
    return { label: this.#label, confidence: 1 };
  }
}

function noulRequest(disclosure: "public" | "local-only"): NoulRequest {
  return {
    purpose: "contradiction-check",
    instructions: "Are these incompatible?",
    evidence: { left: "secret situation", right: "other" },
    disclosure,
    threshold: 0.6,
  };
}

function choiceRequest(disclosure: "public" | "local-only"): ChoiceRequest {
  return {
    purpose: "categorize",
    instructions: "Pick a category.",
    evidence: { situation: "secret situation" },
    labels: { workflow: null },
    disclosure,
  };
}

describe("DisclosureRoutedClassifier", () => {
  it("never calls the external backend for local-only evidence", async () => {
    const external = new RecordingClassifier({ label: "external" });
    const local = new RecordingClassifier({ label: "local" });
    const routed = new DisclosureRoutedClassifier({ external, local, warningSink: () => {} });

    await routed.noul(noulRequest("local-only"));
    const choice = await routed.choice(choiceRequest("local-only"));

    expect(external.seen).toHaveLength(0);
    expect(local.seen).toHaveLength(2);
    expect(choice.label).toBe("local");
  });

  it("sends public evidence to the external backend", async () => {
    const external = new RecordingClassifier({ label: "external", probability: 0.9 });
    const local = new RecordingClassifier({ label: "local" });
    const routed = new DisclosureRoutedClassifier({ external, local, warningSink: () => {} });

    const judgment = await routed.noul(noulRequest("public"));

    expect(external.seen).toHaveLength(1);
    expect(local.seen).toHaveLength(0);
    expect(judgment).toEqual({ yes: true, probability: 0.9 });
  });

  it("falls back to the local backend when the external one fails, without logging content", async () => {
    const failure = new Error("api key rejected for card 'secret situation'");
    failure.name = "AuthenticationError";
    const external = new RecordingClassifier({ failure });
    const local = new RecordingClassifier({ label: "local" });
    const warnings: string[] = [];
    const routed = new DisclosureRoutedClassifier({
      external,
      local,
      warningSink: (message) => warnings.push(message),
    });

    const choice = await routed.choice(choiceRequest("public"));

    expect(choice.label).toBe("local");
    expect(local.seen).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("AuthenticationError");
    // 判定対象もバックエンドの応答本文も警告へ載せない。
    expect(warnings[0]).not.toContain("secret situation");
    expect(warnings[0]).not.toContain("api key rejected");
  });
});
