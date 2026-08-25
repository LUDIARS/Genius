import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { SqliteIngestFailureStore } from "../../src/ingest/sqlite-ingest-failure-store.js";
import {
  SqliteIngestRunStore,
  SqliteIngestStateStore,
} from "../../src/ingest/sqlite-ingest-stores.js";
import { SourceReaderError } from "../../src/readers/reader-error.js";
import type {
  ListDocumentsOptions,
  ReaderCursor,
  SourceDocument,
  SourceDocumentBatch,
  SourceDocumentDescriptor,
  SourceName,
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

const tierTwoDescriptor: SourceDocumentDescriptor = {
  source: "claude-jsonl",
  tier: 2,
  locator: "session.jsonl",
  mtimeMs: 1,
};

class TierTwoFixtureReader implements SourceReader {
  readonly source = "claude-jsonl" as const;
  readonly tier = 2 as const;
  readonly receivedOptions: ListDocumentsOptions[] = [];

  async listDocuments(
    cursor: ReaderCursor | null,
    options?: ListDocumentsOptions,
  ): Promise<SourceDocumentBatch> {
    this.receivedOptions.push(options ?? {});
    return cursor
      ? { documents: [], nextCursor: cursor }
      : { documents: [tierTwoDescriptor], nextCursor: { mtimeMs: 1, locator: "session.jsonl" } };
  }

  async readDocument(): Promise<SourceDocument> {
    return {
      descriptor: tierTwoDescriptor,
      sourceRef: "claude-jsonl:session.jsonl",
      title: "Session",
      content: "Synthetic transcript",
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
      failures: new SqliteIngestFailureStore(database),
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

  it("keeps Tier 2 out of the default plan without tier2=true", async () => {
    const { resolved, service } = createPlanTracker(database, runs);

    const run = service.start({ allowMissing: true });
    await service.wait(run.id);
    expect(resolved).toEqual([
      "memory",
      "session-logs",
      "channel-archives",
      "review",
      "memoria",
    ]);
  });

  it("plans Tier 1 and Tier 2 when tier2=true omits an explicit source list", async () => {
    // Dropping the "budget is mandatory" throw made bare `--tier2` reachable,
    // so the widened default plan documented in README/setup needs its own
    // guard (spec/feature/operations.md section 6).
    const { resolved, service } = createPlanTracker(database, runs);

    const run = service.start({ tier2: true, allowMissing: true });
    await service.wait(run.id);
    expect(resolved).toEqual([
      "memory",
      "session-logs",
      "channel-archives",
      "review",
      "memoria",
      "claude-jsonl",
      "codex-jsonl",
    ]);
  });

  it("runs Tier 2 without a budget and passes no cap to the reader", async () => {
    // Unbounded path: absence of budgetFiles must reach the reader as absence,
    // not as a silent default cap (spec/feature/operations.md section 6).
    const { reader, service } = createTierTwoHarness(database, runs);

    const run = service.start({ sources: ["claude-jsonl"], tier2: true });
    const finished = await service.wait(run.id);

    expect(finished).toMatchObject({ status: "completed", filesProcessed: 1 });
    expect(reader.receivedOptions).toEqual([{}]);
  });

  it("forwards an explicit budgetFiles to Tier 2 readers as before", async () => {
    const { reader, service } = createTierTwoHarness(database, runs);

    const run = service.start({ sources: ["claude-jsonl"], tier2: true, budgetFiles: 7 });
    const finished = await service.wait(run.id);

    expect(finished).toMatchObject({ status: "completed", filesProcessed: 1 });
    expect(reader.receivedOptions).toEqual([{ budgetFiles: 7 }]);
  });

  it("rejects a non-positive budgetFiles before creating a run", () => {
    const { service } = createTierTwoHarness(database, runs);

    expect(() => service.start({ sources: ["claude-jsonl"], tier2: true, budgetFiles: 0 }))
      .toThrow(IngestValidationError);
    expect(runs.get("run-1")).toBeNull();
  });

  it("rejects budgetFiles without tier2 instead of silently ignoring the cap", () => {
    // The cap only applies to Tier 2 reads, so a Tier 1-only run that supplies
    // one must fail loudly rather than drop it (mirrors the API-level rule kept
    // by spec/feature/operations.md section 6).
    const { service } = createPlanTracker(database, runs);

    expect(() => service.start({ sources: ["memory"], budgetFiles: 5, allowMissing: true }))
      .toThrow("budgetFiles requires tier2=true");
    expect(runs.get("run-1")).toBeNull();
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

  it("reflects per-document progress while the run is still running", async () => {
    const descriptors: SourceDocumentDescriptor[] = [
      { source: "memory", tier: 1, locator: "a.md", mtimeMs: 1 },
      { source: "memory", tier: 1, locator: "b.md", mtimeMs: 2 },
    ];
    let releaseSecondDocument: (() => void) | undefined;
    const secondDocumentBlocked = new Promise<void>((resolve) => {
      releaseSecondDocument = resolve;
    });
    let distillCalls = 0;
    const reader: SourceReader = {
      source: "memory",
      tier: 1,
      async listDocuments() {
        return { documents: descriptors, nextCursor: { mtimeMs: 2, locator: "b.md" } };
      },
      async readDocument(target) {
        return {
          descriptor: target,
          sourceRef: `memory:${target.locator}`,
          title: target.locator,
          content: "Synthetic input",
          metadata: {},
        };
      },
    };
    const service = new IngestService({
      distiller: {
        distill: async () => {
          distillCalls += 1;
          if (distillCalls === 2) await secondDocumentBlocked;
          return { cardsCreated: 1, cardsMerged: 0 };
        },
      },
      failures: new SqliteIngestFailureStore(database),
      logger: new MemoryLogger(),
      readers: { resolve: () => reader },
      runs,
      state: new SqliteIngestStateStore(database),
      warningSink: () => undefined,
    });

    const run = service.start({ sources: ["memory"] });
    await vi.waitFor(() => {
      expect(runs.get(run.id)).toMatchObject({
        status: "running",
        filesProcessed: 1,
        cardsCreated: 1,
        cardsMerged: 0,
        skipped: 0,
      });
    });

    releaseSecondDocument?.();
    await expect(service.wait(run.id)).resolves.toMatchObject({
      status: "completed",
      filesProcessed: 2,
    });
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
      failures: new SqliteIngestFailureStore(database),
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

  it("does not write source locators from failures into the log or stderr", async () => {
    // ソースレベル失敗は run を fail させずソース単位で隔離する (Memoria #696)。
    // 変わらない不変条件: ログと warning に locator (絶対パスになり得る) を
    // 転記しない。
    const privateLocator = "C:/private/source.md";
    const logger = new MemoryLogger();
    const warnings: string[] = [];
    const reader = new FixtureReader(
      new SourceReaderError("memory", "cannot read source", { locator: privateLocator }),
    );
    const service = createService(database, runs, logger, reader, (message) => warnings.push(message));
    const run = service.start({ sources: ["memory"] });

    const finished = await service.wait(run.id);

    expect(finished.status).toBe("completed-with-errors");
    expect(finished.error).toBeNull();
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ event: "source-failed", source: "memory" }),
    );
    expect(JSON.stringify(logger.entries)).not.toContain(privateLocator);
    expect(warnings).toEqual([
      `Ingest source failed (run ${run.id}): memory — source-read-failed: [memory] cannot read source`,
    ]);
    expect(warnings.join(" ")).not.toContain(privateLocator);
  });
});

function createPlanTracker(
  database: GeniusDatabase,
  runs: IngestRunStore,
): { resolved: SourceName[]; service: IngestService } {
  const resolved: SourceName[] = [];
  const service = new IngestService({
    distiller: { distill: async () => ({ cardsCreated: 0, cardsMerged: 0 }) },
    failures: new SqliteIngestFailureStore(database),
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
  return { resolved, service };
}

function createTierTwoHarness(
  database: GeniusDatabase,
  runs: IngestRunStore,
): { reader: TierTwoFixtureReader; service: IngestService } {
  const reader = new TierTwoFixtureReader();
  const service = new IngestService({
    distiller: { distill: async () => ({ cardsCreated: 1, cardsMerged: 0 }) },
    failures: new SqliteIngestFailureStore(database),
    logger: new MemoryLogger(),
    readers: { resolve: (source) => source === "claude-jsonl" ? reader : null },
    runs,
    state: new SqliteIngestStateStore(database),
    warningSink: () => undefined,
  });
  return { reader, service };
}

function createService(
  database: GeniusDatabase,
  runs: IngestRunStore,
  logger: IngestLogger,
  reader: SourceReader | null,
  warningSink: (message: string) => void = () => undefined,
): IngestService {
  return new IngestService({
    distiller: { distill: async () => ({ cardsCreated: 0, cardsMerged: 0 }) },
    failures: new SqliteIngestFailureStore(database),
    logger,
    readers: { resolve: (source) => source === "memory" ? reader : null },
    runs,
    state: new SqliteIngestStateStore(database),
    warningSink,
  });
}
