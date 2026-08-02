import { SourceReaderError } from "../readers/reader-error.js";
import { EmbeddingError } from "../embedding/types.js";
import {
  DistillationBackendError,
  DistillationOutputError,
} from "../distill/distill-errors.js";
import type { IngestErrorKind } from "./ingest-contracts.js";

const MAX_MESSAGE_LENGTH = 300;
const MAX_CAUSE_DEPTH = 3;

export interface ClassifiedIngestError {
  kind: IngestErrorKind;
  /** 永続化・通知してよい bounded なメッセージ。文書本文を含まない。 */
  message: string;
}

/**
 * ingest 中の例外を bounded な分類へ落とす。
 *
 * SourceReaderError / EmbeddingError / DistillationBackendError /
 * DistillationOutputError は自前コードが組み立てる管理されたメッセージなので
 * そのまま (絶対パスを basename に落として切り詰めて) 使う。未知の例外は文書本文・LLM 出力の断片を含み得る
 * ため message は転記しないが、「Error」だけでは診断不能 (Memoria #694) なので
 * 例外クラス名 + code + cause 連鎖 + スタック先頭フレーム (ファイル名のみ、
 * 絶対パスは落とす) を残す (本文の転記禁止 — spec/feature/operations.md §4)。
 */
export function classifyIngestError(error: Error): ClassifiedIngestError {
  if (error instanceof SourceReaderError) {
    return { kind: "source-read-failed", message: sanitize(error.message) };
  }
  if (error instanceof EmbeddingError) {
    return { kind: "embedding-failed", message: sanitize(error.message) };
  }
  if (error instanceof DistillationOutputError) {
    return { kind: "distillation-output-invalid", message: sanitize(error.message) };
  }
  if (error instanceof DistillationBackendError) {
    return { kind: "processing-failed", message: sanitize(error.message) };
  }
  if (error.name === "ZodError") {
    return { kind: "distillation-output-invalid", message: describeUnknownError(error) };
  }
  return { kind: "processing-failed", message: describeUnknownError(error) };
}

/** メッセージを転記せずに診断可能な要約を組み立てる。 */
function describeUnknownError(error: Error): string {
  const parts = [error.name];
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && code.length > 0) parts.push(`code=${code}`);
  const causes = causeChainNames(error);
  if (causes.length > 0) parts.push(`cause=${causes.join("<-")}`);
  const frame = topStackFrame(error);
  if (frame !== null) parts.push(`at ${frame}`);
  return truncate(parts.join(" "));
}

function causeChainNames(error: Error): string[] {
  const names: string[] = [];
  let current: unknown = error.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    names.push(current.name);
    current = current.cause;
  }
  return names;
}

/**
 * スタック先頭フレームを「ファイル名:行:列」に落とす。フルパスはユーザ名や
 * ディレクトリ構成を含むため basename だけを残す。
 */
function topStackFrame(error: Error): string | null {
  const frames = error.stack
    ?.split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("at ")) ?? [];
  // 先頭フレームが `at new Promise (<anonymous>)` のように位置を持たないことが
  // あるので、位置を持つ最初のフレームまで見る。
  for (const frame of frames) {
    const location = /([^\s()\\/]+:\d+:\d+)\)?$/.exec(frame)?.[1];
    if (location !== undefined) return location;
  }
  return null;
}

/** Windows/POSIX の絶対パスらしき断片。ユーザ名やディレクトリ構成を含む。 */
const WINDOWS_ABSOLUTE_PATH = /[A-Za-z]:[\\/][^\s"'<>|]*/g;
const POSIX_ABSOLUTE_PATH = /(?<![\w.~])\/(?:[\w.\-+@]+\/)+[\w.\-+@]*/g;

/**
 * 管理されたメッセージでも、reader が組み立てる文言には設定由来の絶対パスが
 * 入り得る (`cannot open source directory: <root>` — src/readers/file-tree.ts)。
 * ingest_failures・logs/ingest.jsonl・Concordia 通知はいずれも絶対パスを
 * 載せない契約 (spec/feature/operations.md §4) なので basename だけに落とす。
 */
export function redactPaths(text: string): string {
  return text
    .replace(WINDOWS_ABSOLUTE_PATH, toBasenameHint)
    .replace(POSIX_ABSOLUTE_PATH, toBasenameHint);
}

function toBasenameHint(match: string): string {
  const basename = match.split(/[\\/]/).filter((segment) => segment.length > 0).at(-1);
  return basename === undefined || basename.includes(":") ? "…" : `…/${basename}`;
}

function sanitize(message: string): string {
  return truncate(redactPaths(message));
}

function truncate(message: string): string {
  return message.length <= MAX_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_MESSAGE_LENGTH)}…`;
}
