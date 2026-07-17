import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type GeniusDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import type {
  IngestLogEntry,
  IngestLogger,
  IngestRunStore,
} from "../../src/ingest/ingest-contracts.js";
import {
  IngestService,
  IngestValidationError,
} from "../../src/ingest/ingest-service.js";
import {
  SqliteIngestRunStore,
  SqliteIngestStateStore,
} from "../../src/ingest/sqlite-ingest-stores.js";
import { SourceReaderError } from "../../src/readers/reader-error.js";
import type {
  ReaderCursor,
  SourceDocument,
  SourceDocumentBatch,
  SourceDocumentDescriptor,
  SourceReader,
} from "../../src/readers/source-reader.js";

const descriptor: SourceDocumentDescriptor = {
  source: "memory",
  tier: 1,
  locator: "fixture.md",
  mtimeMs: 1,
};

class MemoryLogger implements IngestLogger {
  readonly entries: IngestLogEntry[] = [];

  async append(entry: IngestLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

class FixtureReader implements SourceReader {
  readonly source = "memory" as const;
  readonly tier = 1 as const;
  readonly #listError: Error | null;

  constructor(listError: Error | null = null) {
    this.#listError = listError;
  }

  async listDocuments(cursor: ReaderCursor | null): Promise<SourceDocumentBatch> {
    if (this.#listError) throw this.#listError;
    return cursor
      ? { documents: [], nextCursor: cursor }
      : { documents: [descriptor], nextCursor: { mtimeMs: 1, locator: "fixture.md" } };
  }

  async readDocument(): Promise<SourceDocument> {
    return {
      descriptor,
      sourceRef: "memory:fixture.md",
      title: "Fixture",
      content: "Synthetic input",
      metadata: {},
    };
  }
}

describe("IngestService operational behavior", () => {
  let directory: string;
  let database: GeniusDatabase;
  let runs: IngestRunStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "genius-ingest-service-"));
    database = openDatabase(join(directory, "genius.db"));
    runMigrations(database);
    runs = new SqliteIngestRunStore(database, { idFactory: () => "run-1", clock: () => 1 });
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects missing source configuration before creating a run", () => {
    const service = createService(database, runs, new MemoryLogger(), null);

    expect(() => service.start({ sources: ["memory"] })).toThrow(IngestValidationError);
    expect(runs.get("run-1")).toBeNull();
  });

  it("skips an unconfigured source only with allowMissing and emits a warning", async () => {
    const logger = new MemoryLogger();
    const warnings: string[] = [];
    const service = new IngestService({
      distiller: { distill: async () => ({ cardsCreated: 0, cardsMerged: 0 }) },
      logger,
      readers: { resolve: () => null },
      runs,
      state: new SqliteIngestStateStore(database),
      warningSink: (message) => warnings.push(message),
    });

    const run = service.start({ sources: ["memory"], allowMissing: true });
    const finished = await service.wait(run.id);

    expect(finished).toMatchObject({ status: "completed", skipped: 1 });
    expect(warnings).toEqual([
      "Skipping unconfigured ingest source because allowMissing is enabled: memory",
    ]);
    expect(logger.entries).toContainEqual(expect.objectContaining({
      event: "source-skipped",
      source: "memory",
      skipped: 1,
    }));
  });

  it("keeps Tier 2 out of the default plan and requires an explicit budget", async () => {
    const resolved: string[] = [];
    const service = new IngestService({
      distiller: { distill: async () => ({ cardsCreated: 0, cardsMerged: 0 }) },
      logger: new MemoryLogger(),
      readers: {
        resolve: (source) => {
          resolved.push(source);
          return null;
        },
      },
      runs,
      state: new SqliteIngestStateStore(database),
      warningSink: () => undefined,
    });

    const run = service.start({ allowMissing: true });
    await service.wait(run.id);
    expect(resolved).toEqual([
      "memory",
      "session-logs",
      "channel-archives",
      "review",
      "memoria",
    ]);
    expect(() => service.start({ tier2: true, allowMissing: true })).toThrow(
      "explicit budgetFiles",
    );
  });

  it("records a zero-card document as skipped with a document-local reason", async () => {
    const logger = new MemoryLogger();
    const service = createService(database, runs, logger, new FixtureReader());
    const run = service.start({ sources: ["memory"] });

    const finished = await service.wait(run.id);

    expect(finished).toMatchObject({
      status: "completed",
      filesProcessed: 1,
      cardsCreated: 0,
      cardsMerged: 0,
      skipped: 1,
    });
    expect(logger.entries).toContainEqual(expect.objectContaining({
      event: "document-skipped",
      sourceRef: "memory:fixture.md",
      filesProcessed: 1,
      cardsCreated: 0,
      cardsMerged: 0,
      skipped: 1,
      reason: "no-cards-produced",
    }));
  });

  it("rejects a second run that overlaps an active source", async () => {
    let releaseDistillation: (() => void) | undefined;
    const distillationBlocked = new Promise<void>((resolve) => {
      releaseDistillation = resolve;
    });
    const service = new IngestService({
      distiller: {
        distill: async () => {
          await distillationBlocked;
          return { cardsCreated: 0, cardsMerged: 0 };
        },
      },
      logger: new MemoryLogger(),
      readers: { resolve: (source) => source === "memory" ? new FixtureReader() : null },
      runs,
      state: new SqliteIngestStateStore(database),
      warningSink: () => undefined,
    });

    const first = service.start({ sources: ["memory"] });
    expect(() => service.start({ sources: ["memory"] })).toThrowError(
      /already has an active run: memory/,
    );

    releaseDistillation?.();
    await expect(service.wait(first.id)).resolves.toMatchObject({ status: "completed" });
  });

  it("does not persist source locators from failures", async () => {
    const privateLocator = "C:/private/source.md";
    const logger = new MemoryLogger();
    const warnings: string[] = [];
    const reader = new FixtureReader(
      new SourceReaderError("memory", "cannot read source", { locator: privateLocator }),
    );
    const service = createService(database, runs, logger, reader, (message) => warnings.push(message));
    const run = service.start({ sources: ["memory"] });

    const finished = await service.wait(run.id);

    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("Ingest failed: source-read-failed; source=memory");
    expect(JSON.stringify(logger.entries)).not.toContain(privateLocator);
    expect(warnings).toEqual([
      `Ingest run ${run.id} failed: Ingest failed: source-read-failed; source=memory`,
    ]);
    expect(warnings.join(" ")).not.toContain(privateLocator);
  });
});

function createService(
  database: GeniusDatabase,
  runs: IngestRunStore,
  logger: IngestLogger,
  reader: SourceReader | null,
  warningSink: (message: string) => void = () => undefined,
): IngestService {
  return new IngestService({
    distiller: { distill: async () => ({ cardsCreated: 0, cardsMerged: 0 }) },
    logger,
    readers: { resolve: (source) => source === "memory" ? reader : null },
    runs,
    state: new SqliteIngestStateStore(database),
    warningSink,
  });
}
