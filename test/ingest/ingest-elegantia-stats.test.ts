import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type GeniusDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import type {
  IngestElegantiaRoute,
  IngestLogEntry,
  IngestLogger,
} from "../../src/ingest/ingest-contracts.js";
import { IngestService } from "../../src/ingest/ingest-service.js";
import { SqliteIngestFailureStore } from "../../src/ingest/sqlite-ingest-failure-store.js";
import {
  SqliteIngestRunStore,
  SqliteIngestStateStore,
} from "../../src/ingest/sqlite-ingest-stores.js";
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

  async listDocuments(cursor: ReaderCursor | null): Promise<SourceDocumentBatch> {
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

describe("IngestService Elegantia stats", () => {
  let directory: string;
  let database: GeniusDatabase;
  let idSeq: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "genius-ingest-elegantia-"));
    database = openDatabase(join(directory, "genius.db"));
    runMigrations(database);
    idSeq = 0;
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  function service(
    route: IngestElegantiaRoute | null,
    logger: IngestLogger,
    warnings: string[] = [],
  ): IngestService {
    return new IngestService({
      distiller: { distill: async () => ({ cardsCreated: 1, cardsMerged: 0 }) },
      elegantiaRoute: route,
      failures: new SqliteIngestFailureStore(database),
      logger,
      readers: { resolve: () => new FixtureReader() },
      runs: new SqliteIngestRunStore(database, { idFactory: () => `run-${++idSeq}`, clock: () => 1 }),
      state: new SqliteIngestStateStore(database),
      warningSink: (message) => warnings.push(message),
    });
  }

  it("records the flush counts on the run and in the ingest log", async () => {
    const logger = new MemoryLogger();
    const ingest = service({ flush: async () => ({ registered: 2, failed: 1 }) }, logger);

    const run = ingest.start({ sources: ["memory"] });
    const finished = await ingest.wait(run.id);

    expect(finished).toMatchObject({
      status: "completed",
      cardsCreated: 1,
      elegantia: { registered: 2, failed: 1 },
    });
    expect(logger.entries).toContainEqual(expect.objectContaining({
      event: "elegantia-flushed",
      elegantia: { registered: 2, failed: 1 },
    }));
  });

  it("reports null when the integration is disabled", async () => {
    const ingest = service(null, new MemoryLogger());
    const run = ingest.start({ sources: ["memory"] });
    expect((await ingest.wait(run.id)).elegantia).toBeNull();
  });

  it("keeps the run completed but logs a broken flush loudly", async () => {
    const logger = new MemoryLogger();
    const warnings: string[] = [];
    const ingest = service(
      { flush: async () => { throw new RangeError("outbox unreadable"); } },
      logger,
      warnings,
    );

    const run = ingest.start({ sources: ["memory"] });
    const finished = await ingest.wait(run.id);

    expect(finished).toMatchObject({ status: "completed", elegantia: null });
    expect(warnings.join("\n")).toMatch(/Elegantia outbox flush failed \(RangeError\)/);
    expect(logger.entries).toContainEqual(expect.objectContaining({ event: "elegantia-failed" }));
  });
});
