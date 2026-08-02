import { describe, expect, it } from "vitest";
import { z } from "zod";
import { requestValidatedJson } from "../../src/distill/json-completion.js";
import { DistillationOutputError } from "../../src/distill/distill-errors.js";
import type {
  DistillCompletionRequest,
  DistillLlm,
} from "../../src/distill/distill-llm.js";

const schema = z.object({ cards: z.array(z.object({ id: z.string() })) });
const request: DistillCompletionRequest = {
  purpose: "cards",
  systemPrompt: "Return JSON only.",
  prompt: "synthetic input",
};

function llmReturning(...outputs: string[]): DistillLlm {
  let index = 0;
  return {
    assertReady: async () => {},
    complete: async () => outputs[Math.min(index++, outputs.length - 1)]!,
  };
}

describe("requestValidatedJson", () => {
  it("parses bare JSON output", async () => {
    const result = await requestValidatedJson(llmReturning('{"cards":[]}'), request, schema);
    expect(result).toEqual({ cards: [] });
  });

  it("parses a fenced JSON block", async () => {
    const result = await requestValidatedJson(
      llmReturning('```json\n{"cards":[{"id":"a"}]}\n```'),
      request,
      schema,
    );
    expect(result).toEqual({ cards: [{ id: "a" }] });
  });

  it("parses a fenced JSON block followed by commentary (2026-07-31 の 482 件失敗の実出力形)", async () => {
    const output =
      '```json\n{"cards": []}\n```\n\nThis document is a status log with no counterfactual decisions.';
    const result = await requestValidatedJson(llmReturning(output), request, schema);
    expect(result).toEqual({ cards: [] });
  });

  it("parses JSON preceded and followed by prose without a fence", async () => {
    const output = 'Here is the result:\n{"cards":[{"id":"b"}]}\nLet me know if anything else.';
    const result = await requestValidatedJson(llmReturning(output), request, schema);
    expect(result).toEqual({ cards: [{ id: "b" }] });
  });

  it("parses JSON even when the commentary contains brackets before it", async () => {
    // 解説文の `[` を JSON の開始と誤認しない (`{` 起点も独立に試す)。
    const output = 'Result [see notes below]:\n{"cards":[{"id":"c"}]}\nDone.';
    const result = await requestValidatedJson(llmReturning(output), request, schema);
    expect(result).toEqual({ cards: [{ id: "c" }] });
  });

  it("parses JSON even when the commentary after it contains braces", async () => {
    // 「最後の `}`」で切ると後続解説文まで巻き込むので、括弧の対応で切り出す。
    const output = '{"cards":[{"id":"d"}]}\n\nUse {} when the document has no decision.';
    const result = await requestValidatedJson(llmReturning(output), request, schema);
    expect(result).toEqual({ cards: [{ id: "d" }] });
  });

  it("does not stop at a brace inside a JSON string literal", async () => {
    const output = 'Result:\n{"cards":[{"id":"} not the end \\" either"}]}\nDone.';
    const result = await requestValidatedJson(llmReturning(output), request, schema);
    expect(result).toEqual({ cards: [{ id: '} not the end " either' }] });
  });

  it("fails with a bounded summary that never transcribes the LLM output", async () => {
    const secret = "SECRET-LLM-OUTPUT";
    const llm = llmReturning(`not json at all ${secret}`);
    const error = await requestValidatedJson(llm, request, schema).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DistillationOutputError);
    const message = (error as Error).message;
    expect(message).toContain("after 3 attempts");
    expect(message).toContain("SyntaxError");
    expect(message).not.toContain(secret);
  });

  it("summarizes schema violations as Zod issue codes and paths only", async () => {
    const secret = "SECRET-CARD-VALUE";
    const llm = llmReturning(`{"cards":[{"id":123,"leak":"${secret}"}]}`);
    const error = await requestValidatedJson(llm, request, schema).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DistillationOutputError);
    const message = (error as Error).message;
    expect(message).toContain("ZodError");
    expect(message).toContain("cards.0.id");
    expect(message).not.toContain(secret);
  });
});
