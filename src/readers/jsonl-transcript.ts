import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { SourceReaderError } from "./reader-error.js";
import type { SourceDocumentContent, SourceName } from "./source-reader.js";

export type TranscriptRecordFormatter = (
  record: Readonly<Record<string, unknown>>,
) => string | null;

export function createReplayableJsonlTranscript(
  source: SourceName,
  locator: string,
  absolutePath: string,
  formatter: TranscriptRecordFormatter,
): SourceDocumentContent & AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return streamJsonlTranscript(
        source,
        locator,
        absolutePath,
        formatter,
      )[Symbol.asyncIterator]();
    },
  };
}
export function formatClaudeTranscriptRecord(
  record: Readonly<Record<string, unknown>>,
): string | null {
  const message = record.message;
  const messageRecord = isRecord(message) ? message : null;
  const roleValue = messageRecord?.role ?? record.role ?? record.type;
  const role = normalizeRole(roleValue);
  if (role === null) {
    return null;
  }
  const content = messageRecord?.content
    ?? (typeof message === "string" ? message : record.content);
  return formatTurn(role, extractText(content));
}

export function formatCodexTranscriptRecord(
  record: Readonly<Record<string, unknown>>,
): string | null {
  const payload = isRecord(record.payload) ? record.payload : null;
  if (record.type === "response_item" && payload?.type === "message") {
    const role = normalizeRole(payload.role);
    return role === null ? null : formatTurn(role, extractText(payload.content));
  }
  if (record.type === "event_msg" && payload !== null) {
    const eventRole = payload.type === "user_message"
      ? "user"
      : payload.type === "agent_message"
        ? "assistant"
        : null;
    return eventRole === null ? null : formatTurn(eventRole, extractText(payload.message));
  }

  const role = normalizeRole(record.role);
  return role === null ? null : formatTurn(role, extractText(record.content));
}

async function* streamJsonlTranscript(
  source: SourceName,
  locator: string,
  absolutePath: string,
  formatter: TranscriptRecordFormatter,
): AsyncGenerator<string> {
  const input = createReadStream(absolutePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;
  let emitted = 0;

  try {
    for await (const originalLine of lines) {
      lineNumber += 1;
      const line = lineNumber === 1 && originalLine.charCodeAt(0) === 0xfeff
        ? originalLine.slice(1)
        : originalLine;
      if (line.trim().length === 0) {
        continue;
      }

      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new SourceReaderError(
          source,
          `malformed JSONL at line ${lineNumber}`,
          { locator, cause: error },
        );
      }
      if (!isRecord(value)) {
        throw new SourceReaderError(
          source,
          `JSONL line ${lineNumber} must contain an object`,
          { locator },
        );
      }
      const formatted = formatter(value);
      if (formatted !== null) {
        emitted += 1;
        yield formatted;
      }
    }
  } catch (error) {
    if (error instanceof SourceReaderError) {
      throw error;
    }
    throw new SourceReaderError(source, "cannot stream JSONL source document", {
      locator,
      cause: error,
    });
  } finally {
    lines.close();
    input.destroy();
  }

  if (emitted === 0) {
    throw new SourceReaderError(source, "JSONL transcript contains no conversational records", {
      locator,
    });
  }
}

function extractText(value: unknown): readonly string[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length === 0 ? [] : [text];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextBlock(item));
  }
  return extractTextBlock(value);
}

function extractTextBlock(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return extractText(value);
  }
  if (!isRecord(value)) {
    return [];
  }
  if (value.type === "tool_result" || value.type === "tool_use") {
    return [];
  }
  if (typeof value.text === "string") {
    return extractText(value.text);
  }
  if (typeof value.content === "string" || Array.isArray(value.content)) {
    return extractText(value.content);
  }
  return [];
}

function formatTurn(role: string, parts: readonly string[]): string | null {
  const text = parts.join("\n").trim();
  return text.length === 0 ? null : `[${role}]\n${text}\n`;
}

function normalizeRole(value: unknown): "user" | "assistant" | "system" | null {
  if (value === "user" || value === "human") {
    return "user";
  }
  if (value === "assistant" || value === "agent") {
    return "assistant";
  }
  if (value === "system") {
    return "system";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
