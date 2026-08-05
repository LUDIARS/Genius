export type DistillPurpose =
  | "cards"
  | "sensitive-check"
  | "merge-check"
  | "categorize"
  | "contradiction-check"
  | "question-generation";

export type PromptContent = string | AsyncIterable<string>;

export interface DistillCompletionRequest {
  purpose: DistillPurpose;
  /** Trusted instructions supplied by Genius, never source-derived content. */
  systemPrompt: string;
  /** Untrusted source/card content supplied as user data. */
  prompt: PromptContent;
}

export interface DistillLlm {
  assertReady(): Promise<void>;
  complete(request: DistillCompletionRequest): Promise<string>;
}
