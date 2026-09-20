import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "../api/app.js";
import type { ApiServices } from "../api/contracts.js";
import { CardGroupCache } from "../cards/card-group-cache.js";
import { CardRepository } from "../cards/card-repository.js";
import { CategoryRepository } from "../categories/category-repository.js";
import { loadConfig, type LoadConfigOptions } from "../config/load-config.js";
import type { LoadedGeniusConfig } from "../config/types.js";
import { openConfiguredDatabase, type GeniusDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrate.js";
import { renderDistillPrompt } from "../distill/category-vocabulary.js";
import { createClassifier } from "../classify/create-classifier.js";
import { createDistillLlm } from "../distill/create-distill-llm.js";
import { DistillationService } from "../distill/distillation-service.js";
import { LlmPublicCardGate } from "../distill/public-card-gate.js";
import { CachedEmbeddingClient, EmbeddingCache } from "../embedding/cache.js";
import { EmbeddingModelRegistry } from "../embedding/model-registry.js";
import { OllamaEmbeddingClient } from "../embedding/ollama-client.js";
import type { EmbeddingClient } from "../embedding/types.js";
import { VectorStore } from "../embedding/vector-store.js";
import { ConcordiaRunNotifier } from "../ingest/concordia-run-notifier.js";
import type { IngestRunNotifier } from "../ingest/ingest-contracts.js";
import { IngestService } from "../ingest/ingest-service.js";
import { JsonlIngestLogger } from "../ingest/jsonl-ingest-logger.js";
import { SqliteIngestFailureStore } from "../ingest/sqlite-ingest-failure-store.js";
import { SqliteIngestRunStore, SqliteIngestStateStore } from "../ingest/sqlite-ingest-stores.js";
import { CardFeedbackRepository } from "../feedback/feedback-repository.js";
import { CardFeedbackService } from "../feedback/feedback-service.js";
import { createQueryLogStore } from "../query/create-query-log-store.js";
import { QueryService } from "../query/query-service.js";
import { ConcordiaQuestionChannel } from "../questions/concordia-question-channel.js";
import { ContradictionDetector } from "../questions/contradiction-detector.js";
import { DiscordQuestionRelay } from "../questions/discord-question-relay.js";
import { GapRepository } from "../questions/gap-repository.js";
import { IngestQuestionHook } from "../questions/ingest-question-hook.js";
import { QuestionAnswerService } from "../questions/question-answer-service.js";
import { QuestionGenerationService } from "../questions/question-generation-service.js";
import { QuestionQueueRepository } from "../questions/question-queue-repository.js";
import { QuestionRepository } from "../questions/question-repository.js";
import { createReaderRegistry, type ReaderFactoryInputs } from "../readers/registry.js";
import type { SourceName } from "../readers/source-reader.js";
import { CardService } from "../services/card-service.js";
import { SqliteDistillationCardGateway } from "../services/distillation-card-gateway.js";
import { HealthService } from "../services/health-service.js";
import { QuestionQueueService } from "../services/question-queue-service.js";
import { SqliteQueryVectorPort } from "../services/query-vector-port.js";
import { StatsRepository } from "../stats/stats-repository.js";

export interface GeniusRuntime {
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
  config: LoadedGeniusConfig;
  database: GeniusDatabase;
  embedder: EmbeddingClient;
  /**
   * Question generation (Q4). Q8 wires it to ingest completion; the queue side
   * the UI talks to is `services.questions`.
   */
  questions: QuestionGenerationService;
  services: ApiServices;
}

export interface CreateRuntimeOptions extends LoadConfigOptions {
  checkReadiness?: boolean;
  /** @implements SPEC-GENIUS-BUILD-FRESHNESS — 起動時に一度だけ評価済みの dist 鮮度判定。 */
  buildStale?: boolean;
}

export async function createRuntime(options: CreateRuntimeOptions = {}): Promise<GeniusRuntime> {
  const config = loadConfig(options);
  const database = openConfiguredDatabase(config);
  try {
    runMigrations(database);
    const models = new EmbeddingModelRegistry(database);
    const registeredModel = models.getActive();
    const activeModel = registeredModel ?? {
      model: config.embedding.model,
      dimension: config.embedding.dim,
    };
    if (activeModel.dimension !== config.embedding.dim) {
      throw new Error(
        `Active embedding dimension ${activeModel.dimension} does not match index dimension ${config.embedding.dim}`,
      );
    }
    const rawEmbedder = new OllamaEmbeddingClient({
      baseUrl: config.embedding.baseUrl,
      model: activeModel.model,
      dimension: activeModel.dimension,
      ...(config.embedding.numGpu === null ? {} : { numGpu: config.embedding.numGpu }),
      ...(config.embedding.keepAlive === null ? {} : { keepAlive: config.embedding.keepAlive }),
    });
    const embedder = new CachedEmbeddingClient(rawEmbedder, new EmbeddingCache(database));
    if (options.checkReadiness ?? true) await embedder.assertReady();
    // Do not make a failed first-start model authoritative. A corrected config
    // must be usable on the next start without repairing embedding_meta.
    if (registeredModel === null) {
      models.ensureActive(activeModel.model, activeModel.dimension);
    }

    const llm = createDistillLlm(config);
    const classifier = createClassifier(config, llm);
    if (options.checkReadiness ?? true) await llm.assertReady();
    const publicCardGate = new LlmPublicCardGate(llm);
    const cardsRepository = new CardRepository(database);
    const vectors = new VectorStore(database, activeModel.dimension);
    const cards = new CardService(
      database,
      cardsRepository,
      embedder,
      vectors,
      publicCardGate,
      new CardGroupCache(config.cardGroupCache),
    );
    const queryLog = createQueryLogStore(config.queryLog, database);
    const query = new QueryService({
      embedder,
      vectors: new SqliteQueryVectorPort(database, activeModel.dimension),
      queryLog,
    });
    // The controlled category vocabulary lives in card_categories; the prompt
    // only carries a placeholder so there is never a second hardcoded list.
    const categoryRepository = new CategoryRepository(database);
    const categoryList = categoryRepository.listSync();
    const prompt = renderDistillPrompt(readDistillationPrompt(config), categoryList);
    const distiller = new DistillationService({
      cardGateway: new SqliteDistillationCardGateway(database, embedder, cards),
      categoryNames: categoryList.map((category) => category.name),
      llm,
      prompt,
      publicCardGate,
    });
    const questionRepository = new QuestionRepository(database);
    const gapRepository = new GapRepository(database);
    const questions = new QuestionGenerationService({
      config: config.questions,
      contradictions: new ContradictionDetector({
        database,
        embedder,
        gaps: gapRepository,
        classifier,
        questions: questionRepository,
        situationSimilarityMin: config.contradiction.situationSimilarityMin,
        judgmentSimilarityMax: config.contradiction.judgmentSimilarityMax,
        contradictionThreshold: config.classifier.contradictionThreshold,
      }),
      gaps: gapRepository,
      llm,
      publicCardGate,
      questions: questionRepository,
    });
    // @implements SPEC-GENIUS-ACTIVE-QUESTION-QUEUE
    // @implements SPEC-GENIUS-ACTIVE-QUESTION-ANSWER
    const questionQueue = new QuestionQueueRepository(database);
    const questionAnswers = new QuestionAnswerService({
      cards,
      llm,
      queue: questionQueue,
    });
    const readers = createReaderRegistry(config.sources satisfies ReaderFactoryInputs);
    // @implements SPEC-GENIUS-ACTIVE-QUESTION-INGEST
    const completionHook = new IngestQuestionHook({
      questions,
      queryLog,
      retentionDays: config.queryLog.retentionDays,
      relay: createQuestionRelay(config, questionQueue, questionAnswers),
    });
    const ingest = new IngestService({
      completionHook,
      distiller,
      failures: new SqliteIngestFailureStore(database),
      logger: new JsonlIngestLogger(join(dirname(config.configPath), "logs", "ingest.jsonl")),
      notifier: createRunNotifier(config),
      readers: { resolve: (source: SourceName) => readers.get(source) ?? null },
      runs: new SqliteIngestRunStore(database),
      state: new SqliteIngestStateStore(database),
    });
    const stats = new StatsRepository(database);
    // 評価は CardService ではなく CardRepository を直接見る。判定に要るのは
    // 埋め込み再計算を伴わない retire 状態の読み書きだけで、CardService 経由に
    // すると 1 件の評価ごとに再埋め込み判定が走る (spec/feature/card-feedback.md §4)。
    const feedback = new CardFeedbackService({
      database,
      cards: cardsRepository,
      feedback: new CardFeedbackRepository(database),
      thresholds: config.feedback,
    });
    const services: ApiServices = {
      health: new HealthService(cards, embedder, options.buildStale ?? false),
      query,
      cards,
      categories: categoryRepository,
      ingest,
      stats,
      feedback,
      questions: new QuestionQueueService(questionQueue, questionAnswers),
    };
    let closePromise: Promise<void> | null = null;
    return {
      // @implements SPEC-GENIUS-HTTP-ORIGIN-BOUNDARY
      app: createApp(services, { allowedOrigins: config.server.allowedOrigins }),
      close: () => {
        closePromise ??= (async () => {
          try {
            await ingest.waitForIdle();
          } finally {
            database.close();
          }
        })();
        return closePromise;
      },
      config,
      database,
      embedder,
      questions,
      services,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Q6 の Discord 経路 (spec/feature/active-questioning.md §3.2)。
 * 無効化は許容するが無言にはしない — 片方の経路だけが動いている状態を
 * 起動ログから読み取れるようにする。
 */
function createQuestionRelay(
  config: LoadedGeniusConfig,
  queue: QuestionQueueRepository,
  answers: QuestionAnswerService,
): DiscordQuestionRelay | null {
  // @implements SPEC-GENIUS-ACTIVE-QUESTION-DISCORD
  if (!config.questions.discordEnabled) {
    process.stderr.write(
      "[questions] Discord questions are disabled (questions.discordEnabled is false)\n",
    );
    return null;
  }
  if (config.notify.concordiaBaseUrl === null) {
    process.stderr.write(
      "[questions] Discord questions are disabled (notify.concordiaBaseUrl is null)\n",
    );
    return null;
  }
  if (config.questions.deciderDiscordUserId === null) {
    // 質問の配信は続けるが、回答は取り込まない。 判断者が決まらないまま取り込むと
    // 別人の判断がクローンへ混ざる (§4)。 無言で片方だけ動かさないので 1 行出す。
    process.stderr.write(
      "[questions] questions.deciderDiscordUserId is unset; questions are posted but Discord answers are not ingested\n",
    );
  }
  return new DiscordQuestionRelay({
    answers,
    channel: new ConcordiaQuestionChannel({ baseUrl: config.notify.concordiaBaseUrl }),
    maxPerRun: config.questions.maxPerRun,
    deciderDiscordUserId: config.questions.deciderDiscordUserId,
    queue,
  });
}

function createRunNotifier(config: LoadedGeniusConfig): IngestRunNotifier | null {
  if (config.notify.concordiaBaseUrl === null) {
    // 無効は許容するが無言にはしない (spec/feature/operations.md §4)。
    process.stderr.write(
      "[notify] Concordia run notification is disabled (notify.concordiaBaseUrl is null)\n",
    );
    return null;
  }
  return new ConcordiaRunNotifier({ baseUrl: config.notify.concordiaBaseUrl });
}

function readDistillationPrompt(config: LoadedGeniusConfig): string {
  const path = join(dirname(config.configPath), "prompts", "distill.md");
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Failed to read distillation prompt: ${path}`, { cause: error });
  }
}
