import { sourceNames, type SourceName } from "../readers/source-reader.js";
import type { GeniusDatabase } from "../db/database.js";
import type {
  IngestErrorKind,
  IngestFailureInput,
  IngestFailureRecord,
  IngestFailureStore,
} from "./ingest-contracts.js";

interface IngestFailureRow {
  source: string;
  locator: string;
  mtime_ms: number;
  native_id: string | null;
  run_id: string;
  error_kind: string;
  error_message: string;
  failed_at: number;
  resolved_at: number | null;
}

const ERROR_KINDS: readonly IngestErrorKind[] = [
  "source-read-failed",
  "embedding-failed",
  "distillation-output-invalid",
  "processing-failed",
];

export class SqliteIngestFailureStore implements IngestFailureStore {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;

  constructor(database: GeniusDatabase, clock: () => number = Date.now) {
    this.#database = database;
    this.#clock = clock;
  }

  record(failure: IngestFailureInput): void {
    this.#database
      .prepare(
        `INSERT INTO ingest_failures(
           source, locator, mtime_ms, native_id, run_id, error_kind, error_message,
           failed_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(source, locator) DO UPDATE SET
           mtime_ms = excluded.mtime_ms,
           native_id = excluded.native_id,
           run_id = excluded.run_id,
           error_kind = excluded.error_kind,
           error_message = excluded.error_message,
           failed_at = excluded.failed_at,
           resolved_at = NULL`,
      )
      .run(
        failure.source,
        failure.locator,
        failure.mtimeMs,
        failure.nativeId,
        failure.runId,
        failure.errorKind,
        failure.errorMessage,
        this.#clock(),
      );
  }

  resolve(source: SourceName, locator: string): void {
    this.#database
      .prepare(
        `UPDATE ingest_failures SET resolved_at = ?
          WHERE source = ? AND locator = ? AND resolved_at IS NULL`,
      )
      .run(this.#clock(), source, locator);
  }

  listUnresolved(sources?: readonly SourceName[]): IngestFailureRecord[] {
    const filter = sourceFilter(sources);
    const rows = this.#database
      .prepare<string[], IngestFailureRow>(
        `SELECT * FROM ingest_failures
          WHERE resolved_at IS NULL${filter.clause}
          ORDER BY failed_at ASC, source ASC, locator ASC`,
      )
      .all(...filter.values);
    return rows.map(decodeRow);
  }

  countUnresolved(sources?: readonly SourceName[]): number {
    const filter = sourceFilter(sources);
    const row = this.#database
      .prepare<string[], { count: number }>(
        `SELECT COUNT(*) AS count FROM ingest_failures
          WHERE resolved_at IS NULL${filter.clause}`,
      )
      .get(...filter.values);
    return row?.count ?? 0;
  }
}

function sourceFilter(
  sources: readonly SourceName[] | undefined,
): { clause: string; values: string[] } {
  if (sources === undefined || sources.length === 0) {
    return { clause: "", values: [] };
  }
  const placeholders = sources.map(() => "?").join(", ");
  return { clause: ` AND source IN (${placeholders})`, values: [...sources] };
}

function decodeRow(row: IngestFailureRow): IngestFailureRecord {
  if (!sourceNames.includes(row.source as SourceName)) {
    throw new Error(`ingest_failures contains an invalid source: ${row.source}`);
  }
  if (!ERROR_KINDS.includes(row.error_kind as IngestErrorKind)) {
    throw new Error(`ingest_failures contains an invalid error kind: ${row.error_kind}`);
  }
  return {
    source: row.source as SourceName,
    locator: row.locator,
    mtimeMs: row.mtime_ms,
    nativeId: row.native_id,
    runId: row.run_id,
    errorKind: row.error_kind as IngestErrorKind,
    errorMessage: row.error_message,
    failedAt: row.failed_at,
    resolvedAt: row.resolved_at,
  };
}
