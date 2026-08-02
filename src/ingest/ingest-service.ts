import type { SourceDocumentDescriptor, SourceName } from "../readers/source-reader.js";
import type { SourceReader } from "../readers/source-reader.js";
import { classifyIngestError, redactPaths } from "./failure-classification.js";
import { SourceReaderError } from "../readers/reader-error.js";
import type {
  DocumentDistiller,
  IngestFailureStore,
  IngestLogEntry,
  IngestLogger,
  IngestOptions,
  IngestRunNotificationFailure,
  IngestRunNotifier,
  IngestRunRecord,
  IngestRunStore,
  IngestStateStore,
  IngestTotals,
  ReaderResolver,
} from "./ingest-contracts.js";

const TIER_ONE_SOURCES: readonly SourceName[] = [
  "memory",
  "session-logs",
  "channel-archives",
  "review",
  "memoria",
];
const TIER_TWO_SOURCES: readonly SourceName[] = ["claude-jsonl", "codex-jsonl"];

export interface IngestServiceDependencies {
  clock?: () => number;
  distiller: DocumentDistiller;
  failures: IngestFailureStore;
  logger: IngestLogger;
  /** null = 通知無効 (config で明示)。失敗 run を Concordia chat へ知らせる。 */
  notifier?: IngestRunNotifier | null;
  readers: ReaderResolver;
  runs: IngestRunStore;
  state: IngestStateStore;
  warningSink?: (message: string) => void;
}

export class IngestService {
  readonly #clock: () => number;
  readonly #distiller: DocumentDistiller;
  readonly #failures: IngestFailureStore;
  readonly #logger: IngestLogger;
  readonly #notifier: IngestRunNotifier | null;
  readonly #readers: ReaderResolver;
  readonly #runs: IngestRunStore;
  readonly #state: IngestStateStore;
  readonly #warningSink: (message: string) => void;
  readonly #active = new Map<string, Promise<void>>();
  readonly #activeSources = new Set<SourceName>();

  constructor(dependencies: IngestServiceDependencies) {
    this.#clock = dependencies.clock ?? Date.now;
    this.#distiller = dependencies.distiller;
    this.#failures = dependencies.failures;
    this.#logger = dependencies.logger;
    this.#notifier = dependencies.notifier ?? null;
    this.#readers = dependencies.readers;
    this.#runs = dependencies.runs;
    this.#state = dependencies.state;
    this.#warningSink = dependencies.warningSink ?? ((message) => process.stderr.write(`${message}\n`));
  }

  start(options: IngestOptions): IngestRunRecord {
    const normalized = normalizeOptions(options);
    const readers = this.#resolveReaders(normalized);
    const overlappingSource = normalized.sources.find((source) =>
      this.#activeSources.has(source)
    );
    if (overlappingSource !== undefined) {
      throw new IngestValidationError(
        `Ingest source already has an active run: ${overlappingSource}`,
      );
    }
    const run = this.#runs.create(normalized.sources);
    for (const source of normalized.sources) this.#activeSources.add(source);
    const task = this.#runSafely(run, normalized, readers);
    this.#active.set(run.id, task);
    return run;
  }

  status(id: string): IngestRunRecord | null {
    return this.#runs.get(id);
  }

  unresolvedFailures(sources?: readonly SourceName[]): number {
    return this.#failures.countUnresolved(sources);
  }

  async wait(id: string): Promise<IngestRunRecord> {
    const task = this.#active.get(id);
    if (task) await task;
    const run = this.#runs.get(id);
    if (!run) throw new Error(`Unknown ingest run: ${id}`);
    return run;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#active.values()]);
  }

  #resolveReaders(
    options: NormalizedIngestOptions,
  ): ReadonlyMap<SourceName, SourceReader | null> {
    const readers = new Map<SourceName, SourceReader | null>();
    for (const source of options.sources) {
      const reader = this.#readers.resolve(source);
      if (reader === null && !options.allowMissing) {
        throw new IngestValidationError(`Ingest source is not configured: ${source}`);
      }
      if (reader?.tier === 2 && !options.tier2) {
        throw new IngestValidationError(`Tier 2 source requires tier2=true: ${source}`);
      }
      readers.set(source, reader);
    }
    return readers;
  }

  async #runSafely(
    run: IngestRunRecord,
    options: NormalizedIngestOptions,
    readers: ReadonlyMap<SourceName, SourceReader | null>,
  ): Promise<void> {
    const totals = emptyTotals();
    const failures: IngestRunNotificationFailure[] = [];
    let currentSource: SourceName = options.sources[0] ?? "memory";
    try {
      await this.#logger.append(
        logEntry(this.#clock, run.id, currentSource, totals, "run-started"),
      );
      for (const source of options.sources) {
        currentSource = source;
        const reader = readers.get(source) ?? null;
        if (!reader) {
          totals.skipped += 1;
          const reason = `Skipping unconfigured ingest source because allowMissing is enabled: ${source}`;
          this.#warningSink(reason);
          await this.#logger.append(
            logEntry(this.#clock, run.id, source, skippedTotals(), "source-skipped", reason),
          );
          continue;
        }

        await this.#logger.append(
          logEntry(this.#clock, run.id, source, emptyTotals(), "source-started"),
        );

        try {
          if (options.retryFailed) {
            await this.#retrySource(run.id, source, reader, totals, failures);
          } else {
            await this.#ingestSource(run.id, source, reader, options, totals, failures);
          }
        } catch (error) {
          // listDocuments などソースレベルの失敗で run 全体を落とさない
          // (Memoria #696 — review の列挙失敗が他ソースまで巻き込んでいた)。
          // ingest_failures には記録しない: 文書 locator が無く、--retry-failed
          // が readDocument へ渡せる descriptor を復元できないため。通知と
          // ログで可視化し、次の通常 run が同じソースを再列挙する。
          const failure = error instanceof Error ? error : new Error(String(error));
          const classified = classifyIngestError(failure);
          // locator はソース相対が reader の契約だが、通知は絶対パスを載せない
          // 契約なので念のため basename へ落とす (spec/feature/operations.md §4)。
          const locator =
            failure instanceof SourceReaderError && failure.locator !== null
              ? redactPaths(failure.locator)
              : "<listDocuments>";
          failures.push({
            source,
            locator,
            errorKind: classified.kind,
            errorMessage: classified.message,
            // ingest_failures に無いので通知の再処理案内は --retry-failed に
            // してはいけない (空振りする)。
            scope: "source",
          });
          this.#warningSink(
            `Ingest source failed (run ${run.id}): ${source} — ${classified.kind}: ${classified.message}`,
          );
          await this.#logger.append(
            logEntry(this.#clock, run.id, source, emptyTotals(), "source-failed", classified.message),
          );
        }
      }
      const status = failures.length === 0 ? "completed" : "completed-with-errors";
      this.#runs.finish(run.id, totals, status, failures.length);
      const finalSource = options.sources.at(-1) ?? "memory";
      await this.#logger.append(logEntry(
        this.#clock,
        run.id,
        finalSource,
        totals,
        status === "completed" ? "run-completed" : "run-completed-with-errors",
        status === "completed" ? undefined : `${failures.length} document(s) failed`,
      ));
      if (status === "completed-with-errors") {
        await this.#notifyOutcome(run.id, status, options.sources, failures, null);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const safeFailure = sanitizeFailure(failure, currentSource);
      this.#runs.fail(run.id, totals, safeFailure, failures.length);
      // Keep diagnostics observable without copying source/LLM text from an
      // arbitrary exception into stderr. The durable run record uses the same
      // bounded classification.
      this.#warningSink(`Ingest run ${run.id} failed: ${safeFailure.message}`);
      try {
        await this.#logger.append(
          logEntry(
            this.#clock,
            run.id,
            currentSource,
            totals,
            "run-failed",
            safeFailure.message,
          ),
        );
      } catch (logError) {
        const errorName = logError instanceof Error ? logError.name : "UnknownError";
        this.#warningSink(`Failed to write ingest failure log for run ${run.id} (${errorName})`);
      }
      await this.#notifyOutcome(run.id, "failed", options.sources, failures, safeFailure.message);
    } finally {
      this.#active.delete(run.id);
      for (const source of options.sources) this.#activeSources.delete(source);
    }
  }

  /** 通常 run: カーソル起点の増分。文書単位の失敗は隔離して続行する。 */
  async #ingestSource(
    runId: string,
    source: SourceName,
    reader: SourceReader,
    options: NormalizedIngestOptions,
    totals: IngestTotals,
    failures: IngestRunNotificationFailure[],
  ): Promise<void> {
    const cursor = this.#state.get(source);
    const batch = await reader.listDocuments(cursor, {
      // 未指定は「未読を全部」の意味なので、キー自体を渡さない (operations.md §6)。
      ...(reader.tier === 2 && options.budgetFiles !== undefined
        ? { budgetFiles: options.budgetFiles }
        : {}),
    });
    for (const descriptor of batch.documents) {
      await this.#processDocument(runId, source, reader, descriptor, totals, failures);
    }
    // カーソルは失敗文書を追い越すが、失敗は ingest_failures に永続化済みで
    // --retry-failed がカーソル無関係に再処理する (spec §4)。
    if (batch.nextCursor) this.#state.set(source, batch.nextCursor);
  }

  /** --retry-failed run: 未解決の失敗文書だけをカーソル無関係に再処理する。 */
  async #retrySource(
    runId: string,
    source: SourceName,
    reader: SourceReader,
    totals: IngestTotals,
    failures: IngestRunNotificationFailure[],
  ): Promise<void> {
    for (const pending of this.#failures.listUnresolved([source])) {
      // nativeId は review / memoria の readDocument が必須にするため復元する
      // (落とすと retry が必ず source-read-failed になる)。
      const descriptor: SourceDocumentDescriptor = {
        source,
        tier: reader.tier,
        locator: pending.locator,
        mtimeMs: pending.mtimeMs,
        ...(pending.nativeId === null ? {} : { nativeId: pending.nativeId }),
      };
      await this.#processDocument(runId, source, reader, descriptor, totals, failures);
    }
  }

  /**
   * 1 文書を読み取り・蒸留する。失敗は run を止めず、ingest_failures へ
   * 記録して続行する。成功した文書は既存の失敗記録を解決済みにする。
   */
  async #processDocument(
    runId: string,
    source: SourceName,
    reader: SourceReader,
    descriptor: SourceDocumentDescriptor,
    totals: IngestTotals,
    failures: IngestRunNotificationFailure[],
  ): Promise<void> {
    try {
      const document = await reader.readDocument(descriptor);
      await this.#logger.append({
        ...logEntry(this.#clock, runId, source, emptyTotals(), "document-started"),
        sourceRef: document.sourceRef,
      });
      const result = await this.#distiller.distill(document);
      totals.filesProcessed += 1;
      totals.cardsCreated += result.cardsCreated;
      totals.cardsMerged += result.cardsMerged;
      const skipped = result.cardsCreated === 0;
      if (skipped) totals.skipped += 1;
      this.#failures.resolve(source, descriptor.locator);
      await this.#logger.append({
        ...logEntry(
          this.#clock,
          runId,
          source,
          {
            filesProcessed: 1,
            cardsCreated: result.cardsCreated,
            cardsMerged: result.cardsMerged,
            skipped: skipped ? 1 : 0,
          },
          skipped ? "document-skipped" : "document-completed",
          skipped ? "no-cards-produced" : undefined,
        ),
        sourceRef: document.sourceRef,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const classified = classifyIngestError(failure);
      failures.push({
        source,
        locator: descriptor.locator,
        errorKind: classified.kind,
        errorMessage: classified.message,
        scope: "document",
      });
      this.#warningSink(
        `Ingest document failed (run ${runId}): ${source}:${descriptor.locator} — ${classified.kind}`,
      );
      // 記録側 (DB / jsonl) の失敗で run 全体を落とさない — それでは文書単位の
      // 隔離が成立しない。握りつぶさず warningSink へ出し、run は
      // completed-with-errors として続行する (spec/feature/operations.md §4)。
      try {
        this.#failures.record({
          source,
          locator: descriptor.locator,
          mtimeMs: descriptor.mtimeMs,
          nativeId: descriptor.nativeId ?? null,
          runId,
          errorKind: classified.kind,
          errorMessage: classified.message,
        });
      } catch (storeError) {
        const errorName = storeError instanceof Error ? storeError.name : "UnknownError";
        this.#warningSink(
          `Failed to persist ingest failure for ${source}:${descriptor.locator} (${errorName});`
            + " --retry-failed will not pick it up",
        );
      }
      try {
        await this.#logger.append({
          ...logEntry(
            this.#clock,
            runId,
            source,
            emptyTotals(),
            "document-failed",
            classified.message,
          ),
          sourceRef: `${source}:${descriptor.locator}`,
          errorKind: classified.kind,
        });
      } catch (logError) {
        const errorName = logError instanceof Error ? logError.name : "UnknownError";
        this.#warningSink(
          `Failed to write ingest document failure log for run ${runId} (${errorName})`,
        );
      }
    }
  }

  /**
   * 失敗 run の Concordia 通知。通知失敗は握りつぶさず stderr と
   * logs/ingest.jsonl に明示するが、ingest 本体の結果は覆さない (spec §4)。
   */
  async #notifyOutcome(
    runId: string,
    status: "failed" | "completed-with-errors",
    sources: readonly SourceName[],
    failures: readonly IngestRunNotificationFailure[],
    error: string | null,
  ): Promise<void> {
    if (this.#notifier === null) return;
    try {
      await this.#notifier.notifyRunOutcome({
        runId,
        status,
        sources,
        failedDocuments: failures.length,
        unresolvedFailures: this.#failures.countUnresolved(sources),
        failures,
        error,
      });
    } catch (notifyError) {
      const detail = notifyError instanceof Error ? notifyError.message : String(notifyError);
      this.#warningSink(`Ingest run ${runId} Concordia notification failed: ${detail}`);
      try {
        await this.#logger.append(
          logEntry(this.#clock, runId, sources[0] ?? "memory", emptyTotals(), "notify-failed", detail),
        );
      } catch (logError) {
        const errorName = logError instanceof Error ? logError.name : "UnknownError";
        this.#warningSink(`Failed to write notify failure log for run ${runId} (${errorName})`);
      }
    }
  }
}

interface NormalizedIngestOptions {
  sources: readonly SourceName[];
  tier2: boolean;
  /** Absent means "no cap": Tier 2 readers process every unread file. */
  budgetFiles: number | undefined;
  allowMissing: boolean;
  retryFailed: boolean;
}

function normalizeOptions(options: IngestOptions): NormalizedIngestOptions {
  const tier2 = options.tier2 ?? false;
  const retryFailed = options.retryFailed ?? false;
  if (retryFailed && options.budgetFiles !== undefined) {
    throw new IngestValidationError("retryFailed does not accept budgetFiles");
  }
  // 未指定は無制限 (operations.md §6)。既定値を入れると「全量のつもりで上限が
  // かかる」無言フォールバックになるため、undefined のまま reader へ渡す。
  const budgetFiles = options.budgetFiles;
  if (budgetFiles !== undefined && (!Number.isSafeInteger(budgetFiles) || budgetFiles <= 0)) {
    throw new IngestValidationError("budgetFiles must be a positive integer");
  }
  // budgetFiles only caps Tier 2 reads, so accepting it without tier2 would
  // silently drop the caller's cap. Reject instead of ignoring.
  if (budgetFiles !== undefined && !tier2) {
    throw new IngestValidationError("budgetFiles requires tier2=true");
  }
  const defaults = tier2 ? [...TIER_ONE_SOURCES, ...TIER_TWO_SOURCES] : [...TIER_ONE_SOURCES];
  const sources = options.sources ? [...new Set(options.sources)] : defaults;
  if (sources.length === 0) {
    throw new IngestValidationError("At least one ingest source is required");
  }
  for (const source of sources) {
    if (TIER_TWO_SOURCES.includes(source) && !tier2) {
      throw new IngestValidationError(`Tier 2 source requires tier2=true: ${source}`);
    }
  }
  return {
    sources,
    tier2,
    budgetFiles,
    allowMissing: options.allowMissing ?? false,
    retryFailed,
  };
}

export class IngestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestValidationError";
  }
}

function emptyTotals(): IngestTotals {
  return { filesProcessed: 0, cardsCreated: 0, cardsMerged: 0, skipped: 0 };
}

function skippedTotals(): IngestTotals {
  return { filesProcessed: 0, cardsCreated: 0, cardsMerged: 0, skipped: 1 };
}

function sanitizeFailure(error: Error, source: SourceName): Error {
  // 文書単位の隔離と同じ分類を使う (分類規則の二重管理を避ける)。message は
  // 転記せず kind だけを残す — run 単位の失敗はソースが特定できれば十分。
  return new Error(`Ingest failed: ${classifyIngestError(error).kind}; source=${source}`);
}

function logEntry(
  clock: () => number,
  runId: string,
  source: SourceName,
  totals: IngestTotals,
  event: IngestLogEntry["event"],
  reason?: string,
): IngestLogEntry {
  return {
    at: new Date(clock()).toISOString(),
    runId,
    source,
    event,
    ...(reason === undefined ? {} : { reason }),
    ...totals,
  };
}

export function isTierTwoDescriptor(descriptor: SourceDocumentDescriptor): boolean {
  return descriptor.tier === 2;
}
