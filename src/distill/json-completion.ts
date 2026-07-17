import type { ZodType } from "zod";
import type { DistillCompletionRequest, DistillLlm } from "./distill-llm.js";

const MAX_RETRIES = 2;

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export async function requestValidatedJson<T>(
  llm: DistillLlm,
  request: DistillCompletionRequest,
  schema: ZodType<T>,
): Promise<T> {
  const failures: string[] = [];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const raw = await llm.complete(request);
    try {
      const parsed: unknown = JSON.parse(stripJsonFence(raw));
      return schema.parse(parsed);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(
    `Distillation returned invalid JSON after ${MAX_RETRIES + 1} attempts: ${failures.join(" | ")}`,
  );
}
