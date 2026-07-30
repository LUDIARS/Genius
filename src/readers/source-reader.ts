import { z } from "zod";

export const sourceNames = [
  "memory",
  "session-logs",
  "channel-archives",
  "review",
  "memoria",
  "claude-jsonl",
  "codex-jsonl",
] as const;

export const sourceNameSchema = z.enum(sourceNames);
export type SourceName = (typeof sourceNames)[number];
export type SourceTier = 1 | 2;

export interface CursorPosition {
  readonly mtimeMs: number;
  readonly locator: string;
}

/**
 * The top-level position remains the committed recent high-water mark and is
 * compatible with the original `{mtimeMs, locator}` cursor JSON. Tier 2 adds
 * enough state to drain an old backlog while independently catching up files
 * that arrived after that high-water mark.
 */
export interface ReaderCursor extends CursorPosition {
  readonly backfill?: CursorPosition;
  readonly catchUp?: {
    readonly target: CursorPosition;
    readonly before: CursorPosition;
  };
}

export interface SourceDocumentDescriptor {
  readonly source: SourceName;
  readonly tier: SourceTier;
  /** Stable source-relative path or API resource key. */
  readonly locator: string;
  readonly mtimeMs: number;
  readonly sizeBytes?: number;
  /** Reader-private stable ID, such as an API path or Review manifest path. */
  readonly nativeId?: string;
}

export type SourceDocumentContent = string | AsyncIterable<string>;

export interface SourceDocument {
  readonly descriptor: SourceDocumentDescriptor;
  readonly sourceRef: string;
  readonly title: string | null;
  /** Tier 2 transcripts expose a lazy stream and must not be materialized. */
  readonly content: SourceDocumentContent;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ListDocumentsOptions {
  /**
   * Optional per-run cap on Tier 2 file reads. Absent means no cap: every
   * unread file is eligible. Ignored by Tier 1 readers.
   */
  readonly budgetFiles?: number;
}

export interface SourceDocumentBatch {
  readonly documents: readonly SourceDocumentDescriptor[];
  /**
   * Persist only after the whole batch was walked. Documents that failed are
   * isolated into `ingest_failures` and replayed by `--retry-failed`, so the
   * cursor is allowed to move past them (spec/feature/operations.md §4).
   */
  readonly nextCursor: ReaderCursor | null;
}

export interface SourceReader {
  readonly source: SourceName;
  readonly tier: SourceTier;

  listDocuments(
    cursor: ReaderCursor | null,
    options?: ListDocumentsOptions,
  ): Promise<SourceDocumentBatch>;

  readDocument(descriptor: SourceDocumentDescriptor): Promise<SourceDocument>;
}

export function sourceRefFor(descriptor: SourceDocumentDescriptor): string {
  return `${descriptor.source}:${descriptor.locator}`;
}
