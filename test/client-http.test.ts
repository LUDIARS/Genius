import { describe, expect, it, vi } from "vitest";
import {
  GeniusHttpClient,
  GeniusHttpClientError,
  isIngestRunFinished,
  isIngestRunSuccessful,
  normalizeLoopbackBaseUrl,
  resolveGeniusBaseUrl,
} from "../src/client/index.js";

const INGEST_RUN = {
  id: "01J00000000000000000000001",
  sources: ["memory"],
  status: "completed-with-errors" as const,
  filesProcessed: 3,
  cardsCreated: 2,
  cardsMerged: 0,
  skipped: 1,
  failedDocuments: 1,
  startedAt: 1,
  finishedAt: 2,
  error: null,
  unresolvedFailures: 1,
};

const CARD = {
  id: "01J00000000000000000000000",
  domain: "work" as const,
  visibility: "public" as const,
  category: null,
  situation: "A decision is needed",
  judgment: "Choose the reversible option",
  rationale: "It preserves information",
  tags: ["design"],
  sourceRef: "memory:fixture#decision",
  sourceTier: 1 as const,
  confidence: 0.9,
  supersededBy: null,
  retiredAt: null,
  createdAt: 1,
  updatedAt: 1,
  score: 0.87,
};

describe("GeniusHttpClient", () => {
  it("queries the local API without following redirects", async () => {
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ cards: [CARD], tookMs: 12 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new GeniusHttpClient({
      baseUrl: "http://127.0.0.1:4230/",
      fetch: fetchImplementation as typeof fetch,
    });

    await expect(client.query({ text: " reversible ", domain: "work", k: 8 })).resolves.toEqual({
      cards: [CARD],
      tookMs: 12,
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:4230/api/clone/query");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "reversible", domain: "work", k: 8 });
  });

  it("rejects non-loopback and non-http base URLs", () => {
    expect(() => normalizeLoopbackBaseUrl("https://127.0.0.1:4230")).toThrow(/must use http/i);
    expect(() => normalizeLoopbackBaseUrl("http://example.com:4230")).toThrow(/loopback/i);
  });

  it("surfaces status without copying a non-success response body", async () => {
    const client = new GeniusHttpClient({
      baseUrl: "http://localhost:4230",
      fetch: vi.fn(async () => new Response("database unavailable", { status: 503 })) as typeof fetch,
    });

    const error = await client.query({ text: "query" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GeniusHttpClientError);
    expect(error).toMatchObject({ status: 503 });
    expect((error as Error).message).toBe("Genius query failed with HTTP 503");
    expect((error as Error).message).not.toContain("database unavailable");
  });

  it("batches several queries through /api/clone/query-batch in one request", async () => {
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ results: [{ cards: [CARD], tookMs: 3 }, { cards: [], tookMs: 4 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new GeniusHttpClient({
      baseUrl: "http://127.0.0.1:4230",
      fetch: fetchImplementation as typeof fetch,
    });

    const results = await client.queryMany([
      { text: "reversible", k: 8 },
      { text: "irreversible", k: 8 },
    ]);

    expect(results).toEqual([{ cards: [CARD], tookMs: 3 }, { cards: [], tookMs: 4 }]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:4230/api/clone/query-batch");
    expect(JSON.parse(String(init?.body))).toEqual({
      queries: [
        { text: "reversible", k: 8 },
        { text: "irreversible", k: 8 },
      ],
    });
  });

  it("rejects a batch response whose result count does not match the request", async () => {
    const client = new GeniusHttpClient({
      baseUrl: "http://127.0.0.1:4230",
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ results: [{ cards: [], tookMs: 1 }] })),
      ) as typeof fetch,
    });

    await expect(
      client.queryMany([{ text: "a" }, { text: "b" }]),
    ).rejects.toThrow(/returned 1 results for 2 inputs/);
  });

  it("reads an ingest run status including completed-with-errors", async () => {
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(INGEST_RUN), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new GeniusHttpClient({
      baseUrl: "http://127.0.0.1:4230",
      fetch: fetchImplementation as typeof fetch,
    });

    await expect(client.getIngestRun("01J00000000000000000000001")).resolves.toEqual(INGEST_RUN);
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "http://127.0.0.1:4230/api/clone/ingest/runs/01J00000000000000000000001",
    );
    expect(init?.redirect).toBe("error");
  });

  it("rejects an ingest run status that omits the failure counters", async () => {
    const { failedDocuments: _failedDocuments, ...withoutCounters } = INGEST_RUN;
    const client = new GeniusHttpClient({
      baseUrl: "http://127.0.0.1:4230",
      fetch: vi.fn(async () => new Response(JSON.stringify(withoutCounters))) as typeof fetch,
    });

    await expect(client.getIngestRun("run-1")).rejects.toThrow(/invalid response/i);
  });

  it("rejects malformed success responses", async () => {
    const client = new GeniusHttpClient({
      baseUrl: "http://127.0.0.1:4230",
      fetch: vi.fn(async () => new Response(JSON.stringify({ cards: "wrong", tookMs: 1 }))) as typeof fetch,
    });

    await expect(client.query({ text: "query" })).rejects.toThrow(/invalid response/i);
  });

  it("sends validated feedback with an encoded card id and public-only restriction", async () => {
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({
          id: "feedback-1",
          summary: { great: 0, good: 1, poor: 0, notInCase: 0 },
          archived: false,
        })),
    );
    const client = new GeniusHttpClient({
      baseUrl: "http://127.0.0.1:4230",
      fetch: fetchImplementation as typeof fetch,
    });

    await expect(client.sendCardFeedback(
      { cardId: "card/one", rating: "good", note: " useful " },
      { publicOnly: true },
    )).resolves.toMatchObject({ id: "feedback-1", archived: false });
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:4230/api/clone/cards/card%2Fone/feedback");
      expect(JSON.parse(String(init?.body))).toEqual({
        cardId: "card/one",
        rating: "good",
      note: "useful",
      publicOnly: true,
    });
    expect(init?.redirect).toBe("error");
  });
});

describe("ingest run status predicates", () => {
  it("treats completed-with-errors as a finished, successful run", () => {
    expect(isIngestRunFinished("running")).toBe(false);
    expect(isIngestRunFinished("completed-with-errors")).toBe(true);
    expect(isIngestRunFinished("failed")).toBe(true);

    // 「completed 以外は失敗」判定の回帰防止 (spec/feature/operations.md §4)。
    expect(isIngestRunSuccessful("completed")).toBe(true);
    expect(isIngestRunSuccessful("completed-with-errors")).toBe(true);
    expect(isIngestRunSuccessful("failed")).toBe(false);
    expect(isIngestRunSuccessful("running")).toBe(false);
  });
});

describe("Genius client URL configuration", () => {
  it("uses an explicit loopback URL or the configured port", () => {
    expect(resolveGeniusBaseUrl({ GENIUS_BASE_URL: "http://localhost:5000/" })).toBe(
      "http://localhost:5000",
    );
    expect(resolveGeniusBaseUrl({ GENIUS_PORT: "5001" })).toBe("http://127.0.0.1:5001");
    expect(resolveGeniusBaseUrl({}, 4321)).toBe("http://127.0.0.1:4321");
    expect(() => resolveGeniusBaseUrl({})).toThrow(/config/i);
  });

  it("fails on an invalid port rather than falling back", () => {
    expect(() => resolveGeniusBaseUrl({ GENIUS_PORT: "0" })).toThrow(/between 1 and 65535/);
    expect(() => resolveGeniusBaseUrl({ GENIUS_PORT: "not-a-port" })).toThrow(/integer/);
  });
});
