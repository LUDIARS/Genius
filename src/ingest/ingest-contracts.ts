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
  /**
   * ingest_failures テーブルの未解決文書だけを、カーソルと無関係に再処理する。
   * 成功した文書は resolved_at が立つ (spec/feature/operations.md §4)。
   */
  retryFailed?: boolean;
}

export type IngestRunStatus = "running" | "completed" | "completed-with-errors" | "failed";

export interface IngestRunRecord {
  id: string;
  sources: readonly SourceName[];
  status: IngestRunStatus;
  filesProcessed: number;
  cardsCreated: number;
  cardsMerged: number;
  skipped: number;
  /** 文書単位で隔離されたエラー件数。0 なら completed、1 以上なら completed-with-errors。 */
  failedDocuments: number;
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
  finish(
    id: string,
    totals: IngestTotals,
    status: "completed" | "completed-with-errors",
    failedDocuments: number,
  ): void;
  /** failedDocuments は必須 — 隔離済みの件数を無言で 0 に落とさない。 */
  fail(id: string, totals: IngestTotals, error: Error, failedDocuments: number): void;
  get(id: string): IngestRunRecord | null;
}

export type IngestErrorKind =
  | "source-read-failed"
  | "embedding-failed"
  | "distillation-output-invalid"
  | "processing-failed";

export interface IngestFailureInput {
  source: SourceName;
  locator: string;
  mtimeMs: number;
  /**
   * reader 私有の安定 ID (`SourceDocumentDescriptor.nativeId`)。review /
   * memoria の readDocument はこれが無いと descriptor を受け付けないため、
   * --retry-failed で descriptor を復元できるよう保存する。本文ではなく
   * ソース相対パス / API パスのみ (§4 の非転記ルール)。
   */
  nativeId: string | null;
  runId: string;
  errorKind: IngestErrorKind;
  errorMessage: string;
}

export interface IngestFailureRecord extends IngestFailureInput {
  failedAt: number;
  resolvedAt: number | null;
}

/**
 * 失敗文書の永続化。文書単位で続行するとカーソルが失敗文書を追い越すため、
 * 増分カーソルとは独立にここへ記録し、--retry-failed の入力にする。
 * 本文は保存しない (spec/feature/operations.md §4 の非転記ルール)。
 */
export interface IngestFailureStore {
  record(failure: IngestFailureInput): void;
  resolve(source: SourceName, locator: string): void;
  listUnresolved(sources?: readonly SourceName[]): IngestFailureRecord[];
  countUnresolved(sources?: readonly SourceName[]): number;
}

export interface IngestRunNotificationFailure {
  source: SourceName;
  /** ソース相対 locator。絶対パスは含めない。 */
  locator: string;
  errorKind: IngestErrorKind;
  errorMessage: string;
}

/**
 * run が failed / completed-with-errors で終わったときの通知内容。
 * 載せてよいのは run id・ソース名・失敗件数・エラー種別/メッセージ要約・
 * ソース相対パスのみ。文書本文・カード本文・絶対パスは禁止 (§4)。
 */
export interface IngestRunNotification {
  runId: string;
  status: "failed" | "completed-with-errors";
  sources: readonly SourceName[];
  failedDocuments: number;
  unresolvedFailures: number;
  failures: readonly IngestRunNotificationFailure[];
  /** run 全体を止めた sanitize 済みエラー (failed 時のみ)。 */
  error: string | null;
}

export interface IngestRunNotifier {
  /** 到達不能・非 2xx は throw する (通知の握りつぶし禁止)。 */
  notifyRunOutcome(notification: IngestRunNotification): Promise<void>;
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
    | "document-failed"
    | "run-completed"
    | "run-completed-with-errors"
    | "run-failed"
    | "notify-failed";
  reason?: string;
  errorKind?: IngestErrorKind;
}

export interface IngestLogger {
  append(entry: IngestLogEntry): Promise<void>;
}
