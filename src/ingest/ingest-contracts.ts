import type {
  ReaderCursor,
  SourceName,
  SourceReader,
} from "../readers/source-reader.js";
import type { DistillationResult } from "../distill/distillation-service.js";

export interface IngestOptions {
  sources?: readonly SourceName[];
  tier2?: boolean;
  budgetFiles?: number;
  allowMissing?: boolean;
}

export interface IngestRunRecord {
  id: string;
  sources: readonly SourceName[];
  status: "running" | "completed" | "failed";
  filesProcessed: number;
  cardsCreated: number;
  cardsMerged: number;
  skipped: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface IngestStateStore {
  get(source: SourceName): ReaderCursor | null;
  set(source: SourceName, cursor: ReaderCursor): void;
}

export interface IngestRunStore {
  create(sources: readonly SourceName[]): IngestRunRecord;
  finish(id: string, totals: IngestTotals): void;
  fail(id: string, totals: IngestTotals, error: Error): void;
  get(id: string): IngestRunRecord | null;
}

export interface ReaderResolver {
  resolve(source: SourceName): SourceReader | null;
}

export interface DocumentDistiller {
  distill(document: Awaited<ReturnType<SourceReader["readDocument"]>>): Promise<DistillationResult>;
}

export interface IngestTotals {
  filesProcessed: number;
  cardsCreated: number;
  cardsMerged: number;
  skipped: number;
}

export interface IngestLogEntry extends IngestTotals {
  at: string;
  runId: string;
  source: SourceName;
  sourceRef?: string;
  event:
    | "run-started"
    | "source-started"
    | "document-started"
    | "source-skipped"
    | "document-completed"
    | "document-skipped"
    | "run-completed"
    | "run-failed";
  reason?: string;
}

export interface IngestLogger {
  append(entry: IngestLogEntry): Promise<void>;
}
