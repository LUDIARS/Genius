import { describe, expect, it } from "vitest";
import type { DistilledCard } from "../../src/domain/card.js";
import type { DistillCompletionRequest, DistillLlm } from "../../src/distill/distill-llm.js";
import { LlmPublicCardGate } from "../../src/distill/public-card-gate.js";

const PRIVATE_MARKER = "private-marker-never-log";

function publicCard(): DistilledCard {
  return {
    domain: "work",
    visibility: "public",
    situation: `When ${PRIVATE_MARKER} needs a decision`,
    judgment: "Choose a reversible option",
    rationale: "It preserves information",
    tags: ["design"],
    confidence: 0.9,
  };
}

describe("LlmPublicCardGate security boundary", () => {
  it("separates trusted classifier instructions from untrusted card data", async () => {
    let request: DistillCompletionRequest | undefined;
    const llm: DistillLlm = {
      async assertReady() {},
      async complete(value) {
        request = value;
        return '{"sensitive":false,"reason":"safe"}';
      },
    };

    await expect(new LlmPublicCardGate(llm).check(publicCard()))
      .resolves.toMatchObject({ visibility: "public" });

    expect(request?.purpose).toBe("sensitive-check");
    expect(request?.systemPrompt).toContain("untrusted serialized data");
    expect(request?.systemPrompt).not.toContain(PRIVATE_MARKER);
    expect(request?.prompt).toBeTypeOf("string");
    expect(request?.prompt).toContain(PRIVATE_MARKER);
  });

  it("downgrades on classifier errors and emits only a content-safe warning", async () => {
    const warnings: string[] = [];
    const llm: DistillLlm = {
      async assertReady() {},
      async complete() {
        throw new Error(`backend echoed ${PRIVATE_MARKER}`);
      },
    };
    const gate = new LlmPublicCardGate(llm, { warningSink: (message) => warnings.push(message) });

    await expect(gate.check(publicCard())).resolves.toMatchObject({ visibility: "sensitive" });
    expect(warnings).toEqual([
      "[public-card-gate] sensitive check failed; candidate downgraded to sensitive",
    ]);
    expect(warnings.join(" ")).not.toContain(PRIVATE_MARKER);
    expect(warnings.join(" ")).not.toContain("backend echoed");
  });
});
