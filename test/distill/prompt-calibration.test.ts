import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderDistillPrompt } from "../../src/distill/category-vocabulary.js";
import { distilledCardSchema } from "../../src/domain/card.js";

// Guardrail for prompts/distill.md: the prompt file is the single source of truth
// for distillation output shape and few-shot calibration examples. This test does
// not call any LLM (no service startup, no real data) -- it verifies the prompt's
// own embedded examples stay in sync with the DistilledCard schema, and that the
// key stabilizing instructions (empty-result case, raw-JSON-only, redaction rules)
// are not silently dropped by a future edit.

const cardArraySchema = z.object({ cards: z.array(distilledCardSchema) });

const PROMPT_PATH = resolve("prompts/distill.md");
const promptText = readFileSync(PROMPT_PATH, "utf8");

function extractJsonFences(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    blocks.push((match[1] ?? "").trim());
  }
  return blocks;
}

describe("prompts/distill.md calibration", () => {
  const fences = extractJsonFences(promptText);

  it("ships at least a positive and an empty-result few-shot example", () => {
    expect(fences.length).toBeGreaterThanOrEqual(2);
  });

  it("every fenced JSON example parses and matches the distilled card schema", () => {
    for (const fence of fences) {
      const parsed: unknown = JSON.parse(fence);
      const result = cardArraySchema.safeParse(parsed);
      expect(result.success, `example did not match schema: ${fence}`).toBe(true);
    }
  });

  it("includes an example with a real extraction (non-empty cards array)", () => {
    const hasPositive = fences.some((fence) => {
      const parsed = JSON.parse(fence) as { cards: unknown[] };
      return parsed.cards.length > 0;
    });
    expect(hasPositive).toBe(true);
  });

  it("includes an example for the no-decision case (empty cards array)", () => {
    const hasEmpty = fences.some((fence) => {
      const parsed = JSON.parse(fence) as { cards: unknown[] };
      return parsed.cards.length === 0;
    });
    expect(hasEmpty).toBe(true);
  });

  it("documents every required output field", () => {
    for (const field of [
      "situation",
      "judgment",
      "rationale",
      "tags",
      "domain",
      "visibility",
      "category",
      "confidence",
    ]) {
      expect(promptText).toContain(`\`${field}\``);
    }
  });

  it("carries the category vocabulary placeholder instead of a hardcoded list", () => {
    // The controlled vocabulary's source of truth is the card_categories table;
    // the prompt must only ship the placeholder that gets filled at startup
    // (spec/feature/operations.md Section 1.1).
    expect(promptText).toContain("{{category-vocabulary}}");
    expect(renderDistillPrompt(promptText, [
      { name: "impl-design", description: "implementation judgments", createdAt: 1 },
    ])).toContain("- `impl-design` — implementation judgments");
  });

  it("renders operator-supplied descriptions literally, without replacement patterns", () => {
    // Descriptions come from POST /api/clone/categories, so `$&` / `$$` in one
    // must reach the prompt verbatim rather than expand as a replacement pattern.
    expect(renderDistillPrompt(promptText, [
      { name: "budget", description: "costs in $$ and $& terms", createdAt: 1 },
    ])).toContain("- `budget` — costs in $$ and $& terms");
  });

  it("instructs raw JSON only, with no Markdown fences in the model's real output", () => {
    expect(promptText).toMatch(/raw JSON only/i);
    expect(promptText).toMatch(/no Markdown code fences/i);
  });

  it("instructs an empty cards array when no counterfactual decision is present", () => {
    expect(promptText).toContain('{"cards": []}');
  });

  it("prohibits copying identifying details into a card", () => {
    const lower = promptText.toLowerCase();
    expect(lower).toContain("email");
    expect(lower).toContain("credentials");
    expect(lower).toContain("absolute filesystem paths");
  });

  it("does not itself leak a real local filesystem path", () => {
    expect(promptText).not.toMatch(/[A-Za-z]:[\\/]Users[\\/]/);
    expect(promptText).not.toMatch(/E:[\\/]Document/i);
  });
});