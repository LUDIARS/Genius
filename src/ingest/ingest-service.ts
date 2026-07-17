import type { SourceDocumentDescriptor, SourceName } from "../readers/source-reader.js";
import type { SourceReader } from "../readers/source-reader.js";
import { SourceReaderError } from "../readers/reader-error.js";
import { EmbeddingError } from "../embedding/types.js";
import type {
  DocumentDistiller,
  IngestLogger,
  IngestOptions,
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
  logger: IngestLogger;
  readers: ReaderResolver;
  runs: IngestRunStore;
  state: IngestStateStore;
  warningSink?: (message: string) => void;
}

export class IngestService {
  readonly #clock: () => number;
  readonly #distiller: DocumentDistiller;
  readonly #logger: IngestLogger;
  readonly #readers: ReaderResolver;
  readonly #runs: IngestRunStore;
  readonly #state: IngestStateStore;
  readonly #warningSink: (message: string) => void;
  readonly #active = new Map<string, Promise<void>>();
  readonly #activeSources = new Set<SourceName>();

  constructor(dependencies: IngestServiceDependencies) {
    this.#clock = dependencies.clock ?? Date.now;
    this.#distiller = dependencies.distiller;
    this.#logger = dependencies.logger;
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

        const cursor = this.#state.get(source);
        const batch = await reader.listDocuments(cursor, {
          ...(reader.tier === 2 ? { budgetFiles: options.budgetFiles } : {}),
        });
        for (const descriptor of batch.documents) {
          const document = await reader.readDocument(descriptor);
          await this.#logger.append({
            ...logEntry(
              this.#clock,
              run.id,
              source,
              emptyTotals(),
              "document-started",
            ),
            sourceRef: document.sourceRef,
          });
          const result = await this.#distiller.distill(document);
          totals.filesProcessed += 1;
          totals.cardsCreated += result.cardsCreated;
          totals.cardsMerged += result.cardsMerged;
          const skipped = result.cardsCreated === 0;
          if (skipped) totals.skipped += 1;
          await this.#logger.append({
            ...logEntry(
              this.#clock,
              run.id,
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
        }
        if (batch.nextCursor) this.#state.set(source, batch.nextCursor);
      }
      this.#runs.finish(run.id, totals);
      const finalSource = options.sources.at(-1) ?? "memory";
      await this.#logger.append(logEntry(this.#clock, run.id, finalSource, totals, "run-completed"));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const safeFailure = sanitizeFailure(failure, currentSource);
      this.#runs.fail(run.id, totals, safeFailure);
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
    } finally {
      this.#active.delete(run.id);
      for (const source of options.sources) this.#activeSources.delete(source);
    }
  }
}

interface NormalizedIngestOptions {
  sources: readonly SourceName[];
  tier2: boolean;
  budgetFiles: number;
  allowMissing: boolean;
}

function normalizeOptions(options: IngestOptions): NormalizedIngestOptions {
  const tier2 = options.tier2 ?? false;
  if (tier2 && options.budgetFiles === undefined) {
    throw new IngestValidationError("Tier 2 ingest requires an explicit budgetFiles value");
  }
  const budgetFiles = options.budgetFiles ?? 500;
  if (!Number.isSafeInteger(budgetFiles) || budgetFiles <= 0) {
    throw new IngestValidationError("budgetFiles must be a positive integer");
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
  return { sources, tier2, budgetFiles, allowMissing: options.allowMissing ?? false };
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
  const code = error instanceof SourceReaderError
    ? "source-read-failed"
    : error instanceof EmbeddingError
      ? "embedding-failed"
      : error.name === "ZodError"
        ? "distillation-output-invalid"
        : "processing-failed";
  return new Error(`Ingest failed: ${code}; source=${source}`);
}

function logEntry(
  clock: () => number,
  runId: string,
  source: SourceName,
  totals: IngestTotals,
  event:
    | "run-started"
    | "source-started"
    | "document-started"
    | "source-skipped"
    | "document-completed"
    | "document-skipped"
    | "run-completed"
    | "run-failed",
  reason?: string,
): {
  at: string;
  runId: string;
  source: SourceName;
  event: typeof event;
  reason?: string;
  filesProcessed: number;
  cardsCreated: number;
  cardsMerged: number;
  skipped: number;
} {
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
