import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/index.js";
import type { GeniusDatabase } from "../src/db/database.js";
import { openDatabase, runMigrations } from "../src/db/index.js";
import {
  CachedEmbeddingClient,
  EmbeddingCache,
  EmbeddingError,
  OllamaEmbeddingClient,
  type EmbeddingClient,
} from "../src/embedding/index.js";

const databases: GeniusDatabase[] = [];

function migratedDatabase(): GeniusDatabase {
  const database = openDatabase(":memory:");
  databases.push(database);
  runMigrations(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("OllamaEmbeddingClient", () => {
  it("checks model readiness and uses native /api/embed without redirects", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        expect(init?.redirect).toBe("error");
        if (url.endsWith("/api/tags")) {
          return Response.json({ models: [{ name: "bge-m3:latest" }] });
        }
        expect(url).toMatch(/\/api\/embed$/);
        const request = JSON.parse(String(init?.body)) as { input: string[]; model: string };
        expect(request.model).toBe("bge-m3");
        if (request.input.length === 1) {
          expect(request.input[0]).toContain("readiness probe");
          return Response.json({ model: "bge-m3:latest", embeddings: [[1, 0, 0]] });
        }
        expect(request.input).toEqual(["first", "second"]);
        return Response.json({
          model: "bge-m3:latest",
          embeddings: [
            [1, 0, 0],
            [0, 1, 0],
          ],
        });
      },
    );
    const client = new OllamaEmbeddingClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "bge-m3",
      dimension: 3,
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.assertReady()).resolves.toBeUndefined();
    await expect(client.embed(["first", "second"])).resolves.toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  it("sends num_gpu only when it is explicitly configured", async () => {
    const requestBodies: unknown[] = [];
    const client = new OllamaEmbeddingClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "bge-m3",
      dimension: 2,
      numGpu: 0,
      fetch: (async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)) as unknown);
        return Response.json({ model: "bge-m3", embeddings: [[1, 0]] });
      }) as typeof fetch,
    });

    await expect(client.embed(["explicit CPU request"])).resolves.toEqual([[1, 0]]);
    expect(requestBodies).toEqual([{
      model: "bge-m3",
      input: ["explicit CPU request"],
      options: { num_gpu: 0 },
    }]);
  });

  it("fails explicitly for missing models and malformed dimensions", async () => {
    const missingModelFetch = vi.fn(async (): Promise<Response> =>
      Response.json({ models: [{ name: "different:latest" }] }),
    );
    const missingModelClient = new OllamaEmbeddingClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "bge-m3",
      dimension: 3,
      fetch: missingModelFetch as typeof fetch,
    });
    await expect(missingModelClient.assertReady()).rejects.toThrow(/not pulled/);

    const wrongDimensionFetch = vi.fn(async (): Promise<Response> =>
      Response.json({ model: "bge-m3", embeddings: [[1, 2]] }),
    );
    const wrongDimensionClient = new OllamaEmbeddingClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "bge-m3",
      dimension: 3,
      fetch: wrongDimensionFetch as typeof fetch,
    });
    await expect(wrongDimensionClient.embed(["text"])).rejects.toThrow(
      /dimension mismatch/,
    );
  });

  it("does not copy an Ollama error body into embedding errors", async () => {
    const client = new OllamaEmbeddingClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "bge-m3",
      dimension: 3,
      fetch: vi.fn(async () => new Response("sensitive input echoed here", { status: 500 })) as typeof fetch,
    });

    const error = await client.embed(["private input"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as Error).message).toBe("Ollama request failed with HTTP 500");
    expect((error as Error).message).not.toContain("sensitive input");
  });

  it("rejects external base URLs before making a request", () => {
    expect(
      () =>
        new OllamaEmbeddingClient({
          baseUrl: "https://embedding.invalid",
          model: "bge-m3",
          dimension: 1024,
        }),
    ).toThrow(/loopback host/);
  });
});

describe("CachedEmbeddingClient", () => {
  it("caches per text, deduplicates misses, preserves order, and isolates models", async () => {
    const database = migratedDatabase();
    const cache = new EmbeddingCache(database, { clock: () => 100 });
    const calls: string[][] = [];
    const inner: EmbeddingClient = {
      model: "model-a",
      dimension: 2,
      async assertReady() {},
      async embed(texts) {
        calls.push([...texts]);
        return texts.map((text) => (text === "alpha" ? [1, 0] : [0, 1]));
      },
    };
    const client = new CachedEmbeddingClient(inner, cache);

    await expect(client.embed(["alpha", "beta", "alpha"])).resolves.toEqual([
      [1, 0],
      [0, 1],
      [1, 0],
    ]);
    await client.embed(["beta", "alpha"]);
    expect(calls).toEqual([["alpha", "beta"]]);

    const otherCalls: string[][] = [];
    const otherModel = new CachedEmbeddingClient(
      {
        ...inner,
        model: "model-b",
        async embed(texts) {
          otherCalls.push([...texts]);
          return texts.map(() => [0.5, 0.5]);
        },
      },
      cache,
    );
    await otherModel.embed(["alpha"]);
    expect(otherCalls).toEqual([["alpha"]]);
  });

  it("fails on corrupt cache data instead of silently recomputing", () => {
    const database = migratedDatabase();
    database
      .prepare(
        `INSERT INTO embedding_cache(
           model, dim, format_version, text_sha256, embedding, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "model-a",
        2,
        1,
        "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
        Buffer.from([1]),
        1,
      );
    const cache = new EmbeddingCache(database);
    expect(() => cache.get("model-a", 2, "alpha")).toThrowError(EmbeddingError);
  });
});

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftLength += left[index]! ** 2;
    rightLength += right[index]! ** 2;
  }
  return dot / (Math.sqrt(leftLength) * Math.sqrt(rightLength));
}

it.skipIf(process.env.GENIUS_TEST_OLLAMA !== "1")(
  "embeds synthetic semantic text through the real local bge-m3 path",
  async () => {
    const config = loadConfig({
      configPath: resolve("genius.config.example.json"),
      environment: {},
    });
    const client = new OllamaEmbeddingClient({
      baseUrl: config.embedding.baseUrl,
      model: config.embedding.model,
      dimension: config.embedding.dim,
      timeoutMs: 60_000,
      // This machine's installed CUDA toolchain cannot load the current Ollama
      // runner. CPU execution is explicit so the real-path test remains observable.
      numGpu: 0,
    });
    await client.assertReady();
    const [query, related, unrelated] = await client.embed([
      "Validate invalid configuration at the boundary and fail explicitly.",
      "Check configuration early and report a clear error immediately.",
      "Tomato seedlings need water in a sunny garden.",
    ]);
    expect(query).toBeDefined();
    expect(related).toBeDefined();
    expect(unrelated).toBeDefined();
    expect(cosine(query!, related!)).toBeGreaterThan(cosine(query!, unrelated!));
  },
  90_000,
);
