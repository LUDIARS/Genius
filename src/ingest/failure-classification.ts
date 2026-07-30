import { SourceReaderError } from "../readers/reader-error.js";
import { EmbeddingError } from "../embedding/types.js";
import type { IngestErrorKind } from "./ingest-contracts.js";

const MAX_MESSAGE_LENGTH = 300;

export interface ClassifiedIngestError {
  kind: IngestErrorKind;
  /** 永続化・通知してよい bounded なメッセージ。文書本文を含まない。 */
  message: string;
}

/**
 * ingest 中の例外を bounded な分類へ落とす。
 *
 * SourceReaderError / EmbeddingError は自前コードが組み立てる管理された
 * メッセージなのでそのまま (切り詰めて) 使う。Zod エラーや未知の例外は
 * 文書本文・LLM 出力の断片を含み得るため、エラー名だけを残す
 * (本文の転記禁止 — spec/feature/operations.md §4)。
 */
export function classifyIngestError(error: Error): ClassifiedIngestError {
  if (error instanceof SourceReaderError) {
    return { kind: "source-read-failed", message: truncate(error.message) };
  }
  if (error instanceof EmbeddingError) {
    return { kind: "embedding-failed", message: truncate(error.message) };
  }
  if (error.name === "ZodError") {
    return { kind: "distillation-output-invalid", message: "ZodError" };
  }
  return { kind: "processing-failed", message: error.name };
}

function truncate(message: string): string {
  return message.length <= MAX_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_MESSAGE_LENGTH)}…`;
}
