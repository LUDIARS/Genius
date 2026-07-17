import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRepository } from "../../src/cards/card-repository.js";
import { openDatabase, type GeniusDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { EmbeddingClient } from "../../src/embedding/types.js";
import { VectorStore } from "../../src/embedding/vector-store.js";
import type { IngestLogEntry, IngestLogger } from "../../src/ingest/ingest-contracts.js";
import { IngestService } from "../../src/ingest/ingest-service.js";
import { SqliteIngestRunStore, SqliteIngestStateStore } from "../../src/ingest/sqlite-ingest-stores.js";
import type {
  ReaderCursor,
  SourceDocument,
  SourceDocumentBatch,
  SourceDocumentDescriptor,
  SourceReader,
} from "../../src/readers/source-reader.js";
import { CardService } from "../../src/services/card-service.js";

const descriptor: SourceDocumentDescriptor = {
  source: "memory",
  tier: 1,
  locator: "fixture.md",
  mtimeMs: 1,
};

class OneDocumentReader implements SourceReader {
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
      content: "A synthetic decision",
      metadata: {},
    };
  }
}

class MemoryLogger implements IngestLogger {
  readonly entries: IngestLogEntry[] = [];

  async append(entry: IngestLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

class FixedEmbedder implements EmbeddingClient {
  readonly model = "fixed";
  readonly dimension = 1024;
  async assertReady(): Promise<void> {}
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map(() => [1, ...new Array<number>(1023).fill(0)]);
  }
}

describe("incremental ingest", () => {
  let directory: string;
  let database: GeniusDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "genius-ingest-"));
    database = openDatabase(join(directory, "genius.db"));
    runMigrations(database);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("does not create a second card when the same source is ingested twice", async () => {
    const embedder = new FixedEmbedder();
    const repository = new CardRepository(database);
    const cardService = new CardService(
      database,
      repository,
      embedder,
      new VectorStore(database),
      { check: async (card) => card },
    );
    const reader = new OneDocumentReader();
    const runs = new SqliteIngestRunStore(database);
    const service = new IngestService({
      distiller: {
        distill: async (document) => {
          await cardService.saveWithEmbedding({
            domain: "work",
            visibility: "public",
            situation: "A choice is available",
            judgment: "Choose the reversible action",
            rationale: "It preserves information",
            tags: ["fixture"],
            confidence: 1,
            sourceRef: `${document.sourceRef}#card-001`,
            sourceTier: 1,
          });
          return { cardsCreated: 1, cardsMerged: 0 };
        },
      },
      logger: new MemoryLogger(),
      readers: { resolve: (source) => (source === "memory" ? reader : null) },
      runs,
      state: new SqliteIngestStateStore(database),
    });

    const first = service.start({ sources: ["memory"] });
    expect((await service.wait(first.id)).status).toBe("completed");
    const second = service.start({ sources: ["memory"] });
    expect((await service.wait(second.id)).status).toBe("completed");

    expect(repository.count({ includeSuperseded: true })).toBe(1);
    expect(runs.get(first.id)?.filesProcessed).toBe(1);
    expect(runs.get(second.id)?.filesProcessed).toBe(0);
  });
});
