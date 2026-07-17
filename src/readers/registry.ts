import { ChannelArchiveReader } from "./channel-archive-reader.js";
import { ClaudeJsonlReader } from "./claude-jsonl-reader.js";
import { CodexJsonlReader } from "./codex-jsonl-reader.js";
import { MemoriaReader, type FetchImplementation } from "./memoria-reader.js";
import { MemoryReader } from "./memory-reader.js";
import { ReviewReader } from "./review-reader.js";
import { SourceReaderError } from "./reader-error.js";
import { SessionLogReader } from "./session-log-reader.js";
import {
  sourceNames,
  type SourceName,
  type SourceReader,
} from "./source-reader.js";

export interface ReaderFactoryInputs {
  readonly memoryDir?: string | null;
  readonly sessionLogsDir?: string | null;
  readonly channelArchivesDir?: string | null;
  readonly reviewDir?: string | null;
  readonly memoriaBaseUrl?: string | null;
  readonly claudeProjectsDir?: string | null;
  readonly codexSessionsDir?: string | null;
  readonly fetchImplementation?: FetchImplementation;
}
export function createReaderRegistry(
  inputs: ReaderFactoryInputs,
): ReadonlyMap<SourceName, SourceReader> {
  const registry = new Map<SourceName, SourceReader>();
  for (const source of sourceNames) {
    const configuredValue = configuredInput(source, inputs);
    if (configuredValue === null || configuredValue === undefined) {
      continue;
    }
    registry.set(source, createSourceReader(source, inputs));
  }
  return registry;
}

export function createSourceReader(
  source: SourceName,
  inputs: ReaderFactoryInputs,
): SourceReader {
  switch (source) {
    case "memory":
      return new MemoryReader(requireInput(source, inputs.memoryDir));
    case "session-logs":
      return new SessionLogReader(requireInput(source, inputs.sessionLogsDir));
    case "channel-archives":
      return new ChannelArchiveReader(requireInput(source, inputs.channelArchivesDir));
    case "review":
      return new ReviewReader(requireInput(source, inputs.reviewDir));
    case "memoria":
      return new MemoriaReader(
        requireInput(source, inputs.memoriaBaseUrl),
        inputs.fetchImplementation,
      );
    case "claude-jsonl":
      return new ClaudeJsonlReader(requireInput(source, inputs.claudeProjectsDir));
    case "codex-jsonl":
      return new CodexJsonlReader(requireInput(source, inputs.codexSessionsDir));
  }
}

export function requireRegisteredReader(
  registry: ReadonlyMap<SourceName, SourceReader>,
  source: SourceName,
): SourceReader {
  const reader = registry.get(source);
  if (reader === undefined) {
    throw new SourceReaderError(source, "source is not configured");
  }
  return reader;
}

function requireInput(source: SourceName, value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim().length === 0) {
    throw new SourceReaderError(source, "source is not configured");
  }
  return value;
}

function configuredInput(
  source: SourceName,
  inputs: ReaderFactoryInputs,
): string | null | undefined {
  switch (source) {
    case "memory":
      return inputs.memoryDir;
    case "session-logs":
      return inputs.sessionLogsDir;
    case "channel-archives":
      return inputs.channelArchivesDir;
    case "review":
      return inputs.reviewDir;
    case "memoria":
      return inputs.memoriaBaseUrl;
    case "claude-jsonl":
      return inputs.claudeProjectsDir;
    case "codex-jsonl":
      return inputs.codexSessionsDir;
  }
}
