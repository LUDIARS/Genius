import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type GeniusDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import type {
  IngestCompletionHook,
  IngestLogEntry,
  IngestLogger,
  IngestRunNotification,
  IngestRunNotifier,
} from "../../src/ingest/ingest-contracts.js";
import { IngestService } from "../../src/ingest/ingest-service.js";
import { SqliteIngestFailureStore } from "../../src/ingest/sqlite-ingest-failure-store.js";
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

const SECRET_BODY = "SECRET-DOCUMENT-BODY";

const badDescriptor: SourceDocumentDescriptor = {
  source: "memory",
  tier: 1,
  locator: "bad.md",
  mtimeMs: 1,
};

const goodDescriptor: SourceDocumentDescriptor = {
  source: "memory",
  tier: 1,
  locator: "good.md",
  mtimeMs: 2,
};

class MemoryLogger implements IngestLogger {
  readonly entries: IngestLogEntry[] = [];

  async append(entry: IngestLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

class MemoryNotifier implements IngestRunNotifier {
  readonly notifications: IngestRunNotification[] = [];
  failWith: Error | null = null;

  async notifyRunOutcome(notification: IngestRunNotification): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.notifications.push(notification);
  }
}

class TwoDocumentReader implements SourceReader {
  readonly source = "memory" as const;
  readonly tier = 1 as const;
  listCalls = 0;
  readonly readLocators: string[] = [];

  async listDocuments(cursor: ReaderCursor | null): Promise<SourceDocumentBatch> {
    this.listCalls += 1;
    return cursor
      ? { documents: [], nextCursor: cursor }
      : {
          documents: [badDescriptor, goodDescriptor],
          nextCursor: { mtimeMs: 2, locator: "good.md" },
        };
  }

  async readDocument(descriptor: SourceDocumentDescriptor): Promise<SourceDocument> {
    this.readLocators.push(descriptor.locator);
    return {
      descriptor,
      sourceRef: `memory:${descriptor.locator}`,
      title: descriptor.locator,
      content: descriptor.locator === "bad.md" ? SECRET_BODY : "Safe synthetic input",
      metadata: {},
    };
  }
}

/** review / memoria のように reader 私有の nativeId を必須にする reader。 */
class NativeIdReader implements SourceReader {
  readonly source = "memory" as const;
  readonly tier = 1 as const;
  readonly readNativeIds: (string | undefined)[] = [];

  async listDocuments(cursor: ReaderCursor | null): Promise<SourceDocumentBatch> {
    return cursor
      ? { documents: [], nextCursor: cursor }
      : {
          documents: [{ ...badDescriptor, nativeId: "manifests/2026-07-30.json" }],
          nextCursor: { mtimeMs: 1, locator: "bad.md" },
        };
  }

  async readDocument(descriptor: SourceDocumentDescriptor): Promise<SourceDocument> {
    this.readNativeIds.push(descriptor.nativeId);
    if (descriptor.nativeId === undefined) {
      throw new SourceReaderError(this.source, "descriptor has no manifest locator");
    }
    return {
      descriptor,
      sourceRef: `memory:${descriptor.locator}`,
      title: descriptor.locator,
      content: SECRET_BODY,
      metadata: {},
    };
  }
}

describe("ingest failure isolation (spec/feature/operations.md section 4)", () => {
  let directory: string;
  let database: GeniusDatabase;
  let runs: SqliteIngestRunStore;
  let state: SqliteIngestStateStore;
  let failures: SqliteIngestFailureStore;
  let logger: MemoryLogger;
  let notifier: MemoryNotifier;
  let warnings: string[];
  let runCounter: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "genius-ingest-isolation-"));
    database = openDatabase(join(directory, "genius.db"));
    runMigrations(database);
    runCounter = 0;
    runs = new SqliteIngestRunStore(database, { idFactory: () => `run-${++runCounter}` });
    state = new SqliteIngestStateStore(database);
    failures = new SqliteIngestFailureStore(database);
    logger = new MemoryLogger();
    notifier = new MemoryNotifier();
    warnings = [];
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  function createService(
    reader: SourceReader,
    failDistillForBadDocument: boolean,
    completionHook: IngestCompletionHook | null = null,
  ): IngestService {
    return new IngestService({
      completionHook,
      distiller: {
        distill: async (document) => {
          if (failDistillForBadDocument && String(document.content).includes(SECRET_BODY)) {
            // 例外メッセージが本文断片を含む最悪ケース。分類側が本文を
            // 転記しないことを検証する。
            throw new Error(`distillation blew up on: ${SECRET_BODY}`);
          }
          return { cardsCreated: 1, cardsMerged: 0 };
        },
      },
      failures,
      logger,
      notifier,
      readers: { resolve: (source) => (source === "memory" ? reader : null) },
      runs,
      state,
      warningSink: (message) => warnings.push(message),
    });
  }

  it("isolates a failing document, finishes completed-with-errors, and keeps processing", async () => {
    const reader = new TwoDocumentReader();
    const service = createService(reader, true);

    const run = service.start({ sources: ["memory"] });
    const finished = await service.wait(run.id);

    expect(finished).toMatchObject({
      status: "completed-with-errors",
      filesProcessed: 1,
      cardsCreated: 1,
      failedDocuments: 1,
      error: null,
    });
    // 後続文書は処理されている (run は止まらない)。
    expect(reader.readLocators).toEqual(["bad.md", "good.md"]);
    // カーソルは失敗文書を追い越して前進する。
    expect(state.get("memory")).toMatchObject({ mtimeMs: 2, locator: "good.md" });
    expect(logger.entries).toContainEqual(expect.objectContaining({
      event: "document-failed",
      sourceRef: "memory:bad.md",
      errorKind: "processing-failed",
    }));
    expect(logger.entries).toContainEqual(expect.objectContaining({
      event: "run-completed-with-errors",
      reason: "1 document(s) failed",
    }));
  });

  it("persists the failure without the document body and counts it as unresolved", async () => {
    const service = createService(new TwoDocumentReader(), true);
    const run = service.start({ sources: ["memory"] });
    await service.wait(run.id);

    const unresolved = failures.listUnresolved(["memory"]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({
      source: "memory",
      locator: "bad.md",
      mtimeMs: 1,
      runId: run.id,
      errorKind: "processing-failed",
      resolvedAt: null,
    });
    expect(service.unresolvedFailures(["memory"])).toBe(1);
    // 本文非転記: DB・ログ・stderr のどこにも本文断片が出ない。
    expect(unresolved[0]?.errorMessage).not.toContain(SECRET_BODY);
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET_BODY);
    expect(warnings.join(" ")).not.toContain(SECRET_BODY);
  });

  it("notifies Concordia with a redacted payload on completed-with-errors", async () => {
    const service = createService(new TwoDocumentReader(), true);
    const run = service.start({ sources: ["memory"] });
    await service.wait(run.id);

    expect(notifier.notifications).toHaveLength(1);
    const notification = notifier.notifications[0]!;
    expect(notification).toMatchObject({
      runId: run.id,
      status: "completed-with-errors",
      sources: ["memory"],
      failedDocuments: 1,
      unresolvedFailures: 1,
      error: null,
    });
    expect(notification.failures).toEqual([
      expect.objectContaining({
        source: "memory",
        locator: "bad.md",
        errorKind: "processing-failed",
      }),
    ]);
    expect(JSON.stringify(notification)).not.toContain(SECRET_BODY);
  });

  it("does not notify when every document succeeds", async () => {
    const service = createService(new TwoDocumentReader(), false);
    const run = service.start({ sources: ["memory"] });
    const finished = await service.wait(run.id);

    expect(finished).toMatchObject({ status: "completed", failedDocuments: 0 });
    expect(notifier.notifications).toHaveLength(0);
  });

  it("runs the completion hook and notifies when a clean run creates questions", async () => {
    const statuses: string[] = [];
    const service = createService(new TwoDocumentReader(), false, {
      onRunCompleted: async (status) => {
        statuses.push(status);
        return { created: 2, openCount: 4 };
      },
    });

    const run = service.start({ sources: ["memory"] });
    const finished = await service.wait(run.id);

    expect(finished.status).toBe("completed");
    expect(statuses).toEqual(["completed"]);
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]).toMatchObject({
      status: "completed",
      questions: { created: 2, openCount: 4 },
    });
  });

  it("keeps a clean run completed when its completion hook fails", async () => {
    const service = createService(new TwoDocumentReader(), false, {
      onRunCompleted: async () => { throw new Error("question backend unavailable"); },
    });

    const run = service.start({ sources: ["memory"] });
    const finished = await service.wait(run.id);

    expect(finished.status).toBe("completed");
    expect(notifier.notifications).toHaveLength(0);
    expect(warnings).toContain(
      `Ingest run ${run.id} question generation failed: question backend unavailable`,
    );
  });

  it("isolates a listDocuments failure to its source and finishes completed-with-errors", async () => {
    // Memoria #696: review の列挙失敗が run 全体を fail させ、他ソースまで
    // 巻き込んでいた。ソース単位で隔離し、run は completed-with-errors で終わる。
    const reader = new TwoDocumentReader();
    reader.listDocuments = async () => {
      throw new SourceReaderError("memory", "cannot list source", {
        locator: "project/latest.json",
      });
    };
    const service = createService(reader, false);
    const run = service.start({ sources: ["memory"] });
    const finished = await service.wait(run.id);

    expect(finished).toMatchObject({ status: "completed-with-errors", error: null });
    // 文書 locator を復元できないため ingest_failures には記録しない。
    expect(failures.countUnresolved(["memory"])).toBe(0);
    expect(logger.entries).toContainEqual(expect.objectContaining({
      event: "source-failed",
      source: "memory",
    }));
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]?.failures).toEqual([
      expect.objectContaining({
        source: "memory",
        locator: "project/latest.json",
        errorKind: "source-read-failed",
      }),
    ]);
  });

  it("surfaces a notification failure without overturning the ingest result", async () => {
    notifier.failWith = new Error("Concordia unreachable");
    const service = createService(new TwoDocumentReader(), true);
    const run = service.start({ sources: ["memory"] });
    const finished = await service.wait(run.id);

    // 通知失敗は run の結果を覆さない。
    expect(finished.status).toBe("completed-with-errors");
    expect(warnings.some((message) => message.includes("Concordia notification failed"))).toBe(true);
    expect(logger.entries).toContainEqual(expect.objectContaining({ event: "notify-failed" }));
  });

  it("re-processes unresolved failures with --retry-failed independent of the cursor", async () => {
    const firstReader = new TwoDocumentReader();
    const firstService = createService(firstReader, true);
    const firstRun = firstService.start({ sources: ["memory"] });
    await firstService.wait(firstRun.id);
    expect(failures.countUnresolved(["memory"])).toBe(1);

    // カーソルは既に good.md まで進んでいるが、retry はカーソルを見ない。
    const retryReader = new TwoDocumentReader();
    const retryService = createService(retryReader, false);
    const retryRun = retryService.start({ sources: ["memory"], retryFailed: true });
    const finished = await retryService.wait(retryRun.id);

    expect(retryReader.listCalls).toBe(0);
    expect(retryReader.readLocators).toEqual(["bad.md"]);
    expect(finished).toMatchObject({
      status: "completed",
      filesProcessed: 1,
      failedDocuments: 0,
    });
    // 成功したので resolved_at が立つ。
    expect(failures.countUnresolved(["memory"])).toBe(0);
    expect(failures.listUnresolved(["memory"])).toEqual([]);
    // カーソルは retry で変化しない。
    expect(state.get("memory")).toMatchObject({ mtimeMs: 2, locator: "good.md" });
  });

  it("keeps a still-failing document unresolved after --retry-failed", async () => {
    const firstService = createService(new TwoDocumentReader(), true);
    const firstRun = firstService.start({ sources: ["memory"] });
    await firstService.wait(firstRun.id);

    const retryService = createService(new TwoDocumentReader(), true);
    const retryRun = retryService.start({ sources: ["memory"], retryFailed: true });
    const finished = await retryService.wait(retryRun.id);

    expect(finished.status).toBe("completed-with-errors");
    const unresolved = failures.listUnresolved(["memory"]);
    expect(unresolved).toHaveLength(1);
    // 失敗記録は最新 run に付け替えられる。
    expect(unresolved[0]?.runId).toBe(retryRun.id);
  });

  it("restores the reader-private nativeId when retrying (review / memoria descriptors)", async () => {
    const firstService = createService(new NativeIdReader(), true);
    const firstRun = firstService.start({ sources: ["memory"] });
    await firstService.wait(firstRun.id);
    expect(failures.listUnresolved(["memory"])[0]?.nativeId).toBe("manifests/2026-07-30.json");

    const retryReader = new NativeIdReader();
    const retryService = createService(retryReader, false);
    const retryRun = retryService.start({ sources: ["memory"], retryFailed: true });
    const finished = await retryService.wait(retryRun.id);

    // nativeId を落とすと readDocument が source-read-failed で必ず落ちる。
    expect(retryReader.readNativeIds).toEqual(["manifests/2026-07-30.json"]);
    expect(finished.status).toBe("completed");
    expect(failures.countUnresolved(["memory"])).toBe(0);
  });

  it("keeps isolating documents when the failure store and the log both break", async () => {
    // 記録側が落ちても run 全体を fail させない (それでは隔離が成立しない)。
    // 握りつぶしでもない — warningSink に両方の失敗が出る。
    const brokenLogger: IngestLogger = {
      append: async (entry) => {
        if (entry.event === "document-failed") throw new Error("log disk is full");
        await logger.append(entry);
      },
    };
    const reader = new TwoDocumentReader();
    const service = new IngestService({
      distiller: {
        distill: async (document) => {
          if (String(document.content).includes(SECRET_BODY)) {
            throw new Error(`distillation blew up on: ${SECRET_BODY}`);
          }
          return { cardsCreated: 1, cardsMerged: 0 };
        },
      },
      failures: {
        record: () => {
          throw new Error("ingest_failures insert rejected");
        },
        resolve: (source, locator) => failures.resolve(source, locator),
        listUnresolved: (sources) => failures.listUnresolved(sources),
        countUnresolved: (sources) => failures.countUnresolved(sources),
      },
      logger: brokenLogger,
      notifier,
      readers: { resolve: (source) => (source === "memory" ? reader : null) },
      runs,
      state,
      warningSink: (message) => warnings.push(message),
    });

    const run = service.start({ sources: ["memory"] });
    const finished = await service.wait(run.id);

    expect(finished).toMatchObject({
      status: "completed-with-errors",
      filesProcessed: 1,
      failedDocuments: 1,
    });
    expect(reader.readLocators).toEqual(["bad.md", "good.md"]);
    expect(warnings.some((message) => message.includes("Failed to persist ingest failure"))).toBe(
      true,
    );
    expect(
      warnings.some((message) => message.includes("Failed to write ingest document failure log")),
    ).toBe(true);
    expect(warnings.join(" ")).not.toContain(SECRET_BODY);
  });

  it("isolates a listDocuments call that never settles instead of stalling the run forever", async () => {
    vi.useFakeTimers();
    try {
      const reader = new TwoDocumentReader();
      reader.listDocuments = () => new Promise<never>(() => {});
      const service = createService(reader, false);
      const run = service.start({ sources: ["memory"] });
      const finished = service.wait(run.id);

      await vi.advanceTimersByTimeAsync(120_000);
      const result = await finished;

      expect(result).toMatchObject({ status: "completed-with-errors", error: null });
      expect(logger.entries).toContainEqual(expect.objectContaining({
        event: "source-failed",
        source: "memory",
        errorKind: "source-read-failed",
        reason: "[memory] listDocuments timed out after 120000ms",
      }));
      expect(notifier.notifications[0]?.failures).toEqual([
        expect.objectContaining({ source: "memory", errorKind: "source-read-failed" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates a readDocument call that never settles as a document-level failure", async () => {
    vi.useFakeTimers();
    try {
      const reader = new TwoDocumentReader();
      reader.readDocument = () => new Promise<never>(() => {});
      const service = createService(reader, false);
      const run = service.start({ sources: ["memory"] });
      const finished = service.wait(run.id);

      // 2 文書とも readDocument がハングするため、逐次処理の各文書ぶん
      // タイムアウトを進める必要がある。
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await finished;

      expect(result).toMatchObject({ status: "completed-with-errors", failedDocuments: 2 });
      expect(failures.listUnresolved(["memory"])).toHaveLength(2);
      expect(logger.entries).toContainEqual(expect.objectContaining({
        event: "document-failed",
        errorKind: "source-read-failed",
        reason: "[memory] readDocument timed out after 60000ms",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects retryFailed combined with budgetFiles", () => {
    const service = createService(new TwoDocumentReader(), false);
    expect(() =>
      service.start({ sources: ["memory"], retryFailed: true, budgetFiles: 5 }),
    ).toThrowError(/retryFailed does not accept budgetFiles/);
  });
});
