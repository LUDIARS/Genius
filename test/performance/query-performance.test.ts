import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CardRepository } from "../../src/cards/card-repository.js";
import { openDatabase, type GeniusDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import { OllamaEmbeddingClient } from "../../src/embedding/ollama-client.js";
import { VectorStore } from "../../src/embedding/vector-store.js";
import { QueryService } from "../../src/query/query-service.js";
import { SqliteQueryVectorPort } from "../../src/services/query-vector-port.js";

const shouldRun = process.env.GENIUS_TEST_OLLAMA === "1";
const integrationIt = shouldRun ? it : it.skip;
const SAMPLE_COUNT = 20;

describe("1,000-card query performance", () => {
  let directory: string;
  let database: GeniusDatabase;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "genius-perf-"));
    database = openDatabase(join(directory, "genius.db"));
    runMigrations(database);
    const fixedVector = [1, ...new Array<number>(1023).fill(0)];
    let id = 0;
    const cards = new CardRepository(database, {
      idFactory: () => `01PERF${String(id++).padStart(20, "0")}`,
      clock: () => 1,
    });
    const vectors = new VectorStore(database);
    database.transaction(() => {
      for (let index = 0; index < 1_000; index += 1) {
        const card = cards.create({
          domain: index % 2 === 0 ? "work" : "hobby",
          visibility: index % 3 === 0 ? "sensitive" : "public",
          situation: `Synthetic situation ${index}`,
          judgment: `Synthetic judgment ${index}`,
          rationale: `Synthetic rationale ${index}`,
          tags: ["performance"],
          confidence: 0.8,
          sourceRef: `fixture:performance-${index}`,
          sourceTier: index % 5 === 0 ? 2 : 1,
        });
        vectors.insert(card.id, fixedVector);
      }
    })();
  });

  afterAll(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  integrationIt(
    "keeps p95 below 300ms including a real local bge-m3 embedding",
    async () => {
      const embedder = new OllamaEmbeddingClient({
        baseUrl: "http://127.0.0.1:11434",
        model: "bge-m3",
        dimension: 1024,
        // Explicit test configuration for this host's broken GPU runner; never an automatic fallback.
        numGpu: 0,
        timeoutMs: 120_000,
      });
      await embedder.assertReady();
      const service = new QueryService({
        embedder,
        vectors: new SqliteQueryVectorPort(database, 1024),
      });
      await service.query({ text: "warm up local judgment retrieval", k: 8 });

      const durations: number[] = [];
      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        const started = performance.now();
        const result = await service.query({
          text: `choose a reversible implementation option sample ${sample}`,
          domain: "work",
          k: 8,
        });
        durations.push(performance.now() - started);
        expect(result.cards.length).toBeLessThanOrEqual(8);
      }
      durations.sort((left, right) => left - right);
      const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
      process.stdout.write(`[query-performance] cards=1000 samples=${SAMPLE_COUNT} p95=${p95.toFixed(2)}ms\n`);
      // 既定 300ms は GPU 実行時の目標 (spec §6)。Ollama が CPU フォールバック
      // する環境では GENIUS_PERF_P95_MS で実測に合わせて上書きする (waiver は
      // spec/feature/clone-db.md §6 に記録)。
      const p95BudgetMs = Number(process.env.GENIUS_PERF_P95_MS ?? 300);
      expect(p95).toBeLessThan(p95BudgetMs);
    },
    180_000,
  );
});
