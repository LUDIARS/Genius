import { ulid } from "ulid";
import { parseReaderCursor, serializeReaderCursor } from "../readers/cursor.js";
import { sourceNames, type ReaderCursor, type SourceName } from "../readers/source-reader.js";
import type { GeniusDatabase } from "../db/database.js";
import type {
  IngestElegantiaStats,
  IngestRunRecord,
  IngestRunStore,
  IngestStateStore,
  IngestTotals,
} from "./ingest-contracts.js";

interface IngestStateRow {
  cursor: string;
}

interface DistillRunRow {
  id: string;
  source: string;
  files_processed: number;
  cards_created: number;
  cards_merged: number;
  skipped: number;
  started_at: number;
  finished_at: number | null;
  notes: string | null;
}

interface RunNotes {
  status: IngestRunRecord["status"];
  error: string | null;
  failedDocuments: number;
  elegantia: IngestElegantiaStats | null;
}

const RUN_STATUSES: readonly IngestRunRecord["status"][] = [
  "running",
  "completed",
  "completed-with-errors",
  "failed",
];

export class SqliteIngestStateStore implements IngestStateStore {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;

  constructor(database: GeniusDatabase, clock: () => number = Date.now) {
    this.#database = database;
    this.#clock = clock;
  }

  get(source: SourceName): ReaderCursor | null {
    const row = this.#database
      .prepare<[SourceName], IngestStateRow>("SELECT cursor FROM ingest_state WHERE source = ?")
      .get(source);
    return parseReaderCursor(source, row?.cursor ?? null);
  }

  set(source: SourceName, cursor: ReaderCursor): void {
    this.#database
      .prepare(
        `INSERT INTO ingest_state(source, cursor, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
      .run(source, serializeReaderCursor(cursor), this.#clock());
  }
}

export interface SqliteIngestRunStoreOptions {
  clock?: () => number;
  idFactory?: () => string;
}

export class SqliteIngestRunStore implements IngestRunStore {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;
  readonly #idFactory: () => string;

  constructor(database: GeniusDatabase, options: SqliteIngestRunStoreOptions = {}) {
    this.#database = database;
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory ?? ulid;
  }

  create(sources: readonly SourceName[]): IngestRunRecord {
    const record: IngestRunRecord = {
      id: this.#idFactory(),
      sources: [...sources],
      status: "running",
      filesProcessed: 0,
      cardsCreated: 0,
      cardsMerged: 0,
      skipped: 0,
      failedDocuments: 0,
      elegantia: null,
      startedAt: this.#clock(),
      finishedAt: null,
      error: null,
    };
    this.#database
      .prepare(
        `INSERT INTO distill_runs(
           id, source, files_processed, cards_created, cards_merged, skipped,
           started_at, finished_at, notes
         ) VALUES (?, ?, 0, 0, 0, 0, ?, NULL, ?)`,
      )
      .run(
        record.id,
        sources.join(","),
        record.startedAt,
        encodeNotes("running", null, 0, null),
      );
    return record;
  }

  /** @implements SPEC-GENIUS-INGEST-RUN-PROGRESS */
  progress(id: string, totals: IngestTotals): void {
    const result = this.#database
      .prepare(
        `UPDATE distill_runs SET
           files_processed = ?, cards_created = ?, cards_merged = ?, skipped = ?
         WHERE id = ?`,
      )
      .run(totals.filesProcessed, totals.cardsCreated, totals.cardsMerged, totals.skipped, id);
    if (result.changes !== 1) throw new Error(`Unknown ingest run: ${id}`);
  }

  finish(
    id: string,
    totals: IngestTotals,
    status: "completed" | "completed-with-errors",
    failedDocuments: number,
    elegantia: IngestElegantiaStats | null = null,
  ): void {
    this.#updateFinished(id, totals, status, null, failedDocuments, elegantia);
  }

  fail(id: string, totals: IngestTotals, error: Error, failedDocuments: number): void {
    this.#updateFinished(id, totals, "failed", error.message, failedDocuments, null);
  }

  get(id: string): IngestRunRecord | null {
    const row = this.#database
      .prepare<[string], DistillRunRow>("SELECT * FROM distill_runs WHERE id = ?")
      .get(id);
    if (!row) return null;
    const notes = decodeNotes(row.notes, row.id);
    return {
      id: row.id,
      sources: parseSources(row.source),
      status: notes.status,
      filesProcessed: row.files_processed,
      cardsCreated: row.cards_created,
      cardsMerged: row.cards_merged,
      skipped: row.skipped,
      failedDocuments: notes.failedDocuments,
      elegantia: notes.elegantia,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      error: notes.error,
    };
  }

  #updateFinished(
    id: string,
    totals: IngestTotals,
    status: "completed" | "completed-with-errors" | "failed",
    error: string | null,
    failedDocuments: number,
    elegantia: IngestElegantiaStats | null,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE distill_runs SET
           files_processed = ?, cards_created = ?, cards_merged = ?, skipped = ?,
           finished_at = ?, notes = ?
         WHERE id = ?`,
      )
      .run(
        totals.filesProcessed,
        totals.cardsCreated,
        totals.cardsMerged,
        totals.skipped,
        this.#clock(),
        encodeNotes(status, error, failedDocuments, elegantia),
        id,
      );
    if (result.changes !== 1) throw new Error(`Unknown ingest run: ${id}`);
  }
}

function encodeNotes(
  status: RunNotes["status"],
  error: string | null,
  failedDocuments: number,
  elegantia: IngestElegantiaStats | null,
): string {
  return JSON.stringify({ status, error, failedDocuments, elegantia } satisfies RunNotes);
}

function decodeNotes(raw: string | null, runId: string): RunNotes {
  if (raw === null) throw new Error(`Ingest run ${runId} has no status notes`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Ingest run ${runId} has invalid notes JSON`, { cause: error });
  }
  if (!isRecord(value) || !RUN_STATUSES.includes(value.status as RunNotes["status"])) {
    throw new Error(`Ingest run ${runId} has an invalid status`);
  }
  if (value.error !== null && typeof value.error !== "string") {
    throw new Error(`Ingest run ${runId} has an invalid error field`);
  }
  // failedDocuments はこの migration 以降の書き込みにだけ存在する。旧行は 0 扱い。
  // undefined 以外は非負整数を要求する (NaN や小数を API 応答へ流さない)。
  if (
    value.failedDocuments !== undefined
    && !(Number.isSafeInteger(value.failedDocuments) && (value.failedDocuments as number) >= 0)
  ) {
    throw new Error(`Ingest run ${runId} has an invalid failedDocuments field`);
  }
  return {
    status: value.status as RunNotes["status"],
    error: value.error,
    failedDocuments: (value.failedDocuments as number | undefined) ?? 0,
    elegantia: decodeElegantiaStats(value.elegantia, runId),
  };
}

/** Elegantia 連携導入前の行は elegantia を持たない — null として読む。 */
function decodeElegantiaStats(raw: unknown, runId: string): IngestElegantiaStats | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw) || !isCount(raw.registered) || !isCount(raw.failed)) {
    throw new Error(`Ingest run ${runId} has an invalid elegantia field`);
  }
  return { registered: raw.registered, failed: raw.failed };
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseSources(raw: string): SourceName[] {
  const values = raw.split(",").filter((value) => value.length > 0);
  if (!values.every((value): value is SourceName => sourceNames.includes(value as SourceName))) {
    throw new Error(`distill_runs contains invalid source list: ${raw}`);
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
