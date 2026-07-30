import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import type { ApiServices, QueryInput } from "../../src/api/contracts.js";
import { CardRepository } from "../../src/cards/card-repository.js";
import { CategoryRepository } from "../../src/categories/category-repository.js";
import { ingestRunViewSchema } from "../../src/client/ingest-run-contract.js";
import { openDatabase, type GeniusDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { DistilledCard } from "../../src/domain/card.js";
import type { PublicCardGate } from "../../src/distill/public-card-gate.js";
import type { EmbeddingClient } from "../../src/embedding/types.js";
import { VectorStore } from "../../src/embedding/vector-store.js";
import type { IngestOptions, IngestRunRecord } from "../../src/ingest/ingest-contracts.js";
import { IngestValidationError } from "../../src/ingest/ingest-service.js";
import { QueryService } from "../../src/query/query-service.js";
import { CardService } from "../../src/services/card-service.js";
import { HealthService } from "../../src/services/health-service.js";
import { SqliteQueryVectorPort } from "../../src/services/query-vector-port.js";
import { StatsRepository } from "../../src/stats/stats-repository.js";

const DIMENSION = 1024;

class SyntheticEmbedder implements EmbeddingClient {
  readonly model = "synthetic-local";
  readonly dimension = DIMENSION;
  calls = 0;
  invocations = 0;

  async assertReady(): Promise<void> {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls += texts.length;
    this.invocations += 1;
    return texts.map((text) => vectorFor(text));
  }
}

class KeywordPublicCardGate implements PublicCardGate {
  readonly checked: DistilledCard[] = [];

  async check(card: DistilledCard): Promise<DistilledCard> {
    if (card.visibility === "sensitive") return card;
    this.checked.push(card);
    return JSON.stringify(card).includes("private-marker")
      ? { ...card, visibility: "sensitive" }
      : card;
  }
}

describe("clone API", () => {
  let directory: string;
  let database: GeniusDatabase;
  let embedder: SyntheticEmbedder;
  let cards: CardService;
  let publicCardGate: KeywordPublicCardGate;
  let services: ApiServices;
  let ingestOptions: IngestOptions | null;
  let ingestRun: IngestRunRecord;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "genius-api-"));
    database = openDatabase(join(directory, "genius.db"));
    runMigrations(database);
    embedder = new SyntheticEmbedder();
    publicCardGate = new KeywordPublicCardGate();
    const repository = new CardRepository(database);
    const vectors = new VectorStore(database, DIMENSION);
    cards = new CardService(database, repository, embedder, vectors, publicCardGate);
    const query = new QueryService({
      embedder,
      vectors: new SqliteQueryVectorPort(database, DIMENSION),
    });
    const stats = new StatsRepository(database);
    ingestOptions = null;
    ingestRun = {
      id: "01RUN",
      sources: ["memory"],
      status: "running",
      filesProcessed: 0,
      cardsCreated: 0,
      cardsMerged: 0,
      skipped: 0,
      failedDocuments: 0,
      startedAt: 1,
      finishedAt: null,
      error: null,
    };
    services = {
      health: new HealthService(cards, embedder),
      query,
      cards,
      categories: new CategoryRepository(database),
      ingest: {
        start: (options) => {
          ingestOptions = options;
          return ingestRun;
        },
        status: (id) => (id === ingestRun.id ? ingestRun : null),
        unresolvedFailures: () => 0,
      },
      stats,
    };
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("reports model readiness and card count from healthz", async () => {
    await createCard("work", "public", "alpha", "fixture:alpha");
    const response = await createApp(services).request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      model: "synthetic-local",
      cards: 1,
      ollama: true,
    });
  });

  it("queries by quadrant, excludes superseded cards, and obeys k", async () => {
    const alpha = await createCard("work", "public", "alpha", "fixture:alpha");
    await createCard("work", "sensitive", "alpha private", "fixture:private");
    await createCard("hobby", "public", "alpha hobby", "fixture:hobby");
    const old = await createCard("work", "public", "alpha old", "fixture:old");
    cards.markSuperseded(old.id, alpha.id);
    const app = createApp(services);

    const response = await app.request("/api/clone/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "alpha", domain: "work", visibility: "public", k: 1 }),
    });
    const body = (await response.json()) as { cards: Array<{ id: string }>; tookMs: number };

    expect(response.status).toBe(200);
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]?.id).toBe(alpha.id);
    expect(body.cards.some((card) => card.id === old.id)).toBe(false);
    expect(body.tookMs).toBeGreaterThanOrEqual(0);
  });

  it("batches several queries into a single embedding round trip", async () => {
    const alpha = await createCard("work", "public", "alpha", "fixture:alpha");
    const beta = await createCard("hobby", "public", "beta", "fixture:beta");
    const app = createApp(services);
    const invocationsBefore = embedder.invocations;

    const response = await app.request("/api/clone/query-batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: [
          { text: "alpha", domain: "work", k: 1 },
          { text: "beta", domain: "hobby", k: 1 },
        ],
      }),
    });
    const body = (await response.json()) as {
      results: Array<{ cards: Array<{ id: string }>; tookMs: number }>;
    };

    expect(response.status).toBe(200);
    // One Ollama round trip for both queries, not two.
    expect(embedder.invocations).toBe(invocationsBefore + 1);
    expect(body.results).toHaveLength(2);
    expect(body.results[0]?.cards[0]?.id).toBe(alpha.id);
    expect(body.results[1]?.cards[0]?.id).toBe(beta.id);
  });

  it("rejects an empty or oversized query-batch request", async () => {
    const app = createApp(services);

    const empty = await app.request("/api/clone/query-batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: [] }),
    });
    expect(empty.status).toBe(400);

    const tooMany = await app.request("/api/clone/query-batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: Array.from({ length: 51 }, () => ({ text: "alpha" })),
      }),
    });
    expect(tooMany.status).toBe(400);
  });

  it("supports card create, list, get, and patch without exposing DELETE", async () => {
    const app = createApp(services);
    const createdResponse = await app.request("/api/clone/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cardInput("work", "public", "alpha")),
    });
    const created = (await createdResponse.json()) as { id: string };
    const callsAfterCreate = embedder.calls;

    const patchResponse = await app.request(`/api/clone/cards/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "hobby" }),
    });
    const patched = (await patchResponse.json()) as { domain: string };
    const getResponse = await app.request(`/api/clone/cards/${created.id}`);
    const fetched = (await getResponse.json()) as { id: string; domain: string };
    const listResponse = await app.request(
      "/api/clone/cards?domain=hobby&tag=alpha&q=alpha&limit=10&offset=0",
    );
    const listed = (await listResponse.json()) as { cards: Array<{ id: string }> };

    expect(createdResponse.status).toBe(201);
    expect(patchResponse.status).toBe(200);
    expect(patched.domain).toBe("hobby");
    expect(embedder.calls).toBe(callsAfterCreate + 1);
    expect(getResponse.status).toBe(200);
    expect(fetched).toMatchObject({ id: created.id, domain: "hobby" });
    expect(listResponse.status).toBe(200);
    expect(listed.cards.map((card) => card.id)).toEqual([created.id]);
    expect((await app.request("/api/clone/cards/does-not-exist")).status).toBe(404);
    expect((await app.request(`/api/clone/cards/${created.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("starts an ingest run and exposes known and unknown run status", async () => {
    const app = createApp(services);
    const startResponse = await app.request("/api/clone/ingest/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sources: ["claude-jsonl"],
        tier2: true,
        budgetFiles: 7,
        allowMissing: true,
      }),
    });
    const started = (await startResponse.json()) as { id: string; status: string };
    const statusResponse = await app.request(`/api/clone/ingest/runs/${ingestRun.id}`);
    const status = (await statusResponse.json()) as IngestRunRecord;

    expect(startResponse.status).toBe(202);
    expect(started).toEqual({ id: ingestRun.id, status: "running" });
    expect(ingestOptions).toEqual({
      sources: ["claude-jsonl"],
      tier2: true,
      budgetFiles: 7,
      allowMissing: true,
      retryFailed: false,
    });
    expect(statusResponse.status).toBe(200);
    expect(status).toEqual({ ...ingestRun, unresolvedFailures: 0 });
    // 消費側 (GeniusHttpClient.getIngestRun / Timer Delegation polling) の契約と
    // route 応答が乖離しないことを固定する (spec/feature/operations.md §4)。
    expect(ingestRunViewSchema.safeParse(status).success).toBe(true);
    expect((await app.request("/api/clone/ingest/runs/unknown")).status).toBe(404);
  });

  it("accepts tier2 without budgetFiles and forwards it as an unbounded run", async () => {
    // spec/feature/operations.md section 6: a missing budget means "process the
    // whole unread backlog", so the API must not require or inject a cap.
    const app = createApp(services);
    const response = await app.request("/api/clone/ingest/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sources: ["claude-jsonl", "codex-jsonl"], tier2: true }),
    });

    expect(response.status).toBe(202);
    expect(ingestOptions).toEqual({
      sources: ["claude-jsonl", "codex-jsonl"],
      tier2: true,
      allowMissing: false,
      retryFailed: false,
    });
  });

  it("reports stats and exports active public cards without source references", async () => {
    const alpha = await createCard("work", "public", "alpha", "private:absolute-looking-ref");
    await createCard("hobby", "sensitive", "beta", "fixture:sensitive", 2);
    const old = await createCard("work", "public", "old", "fixture:old");
    cards.markSuperseded(old.id, alpha.id);
    database
      .prepare(
        `INSERT INTO distill_runs(
           id, source, files_processed, cards_created, cards_merged, skipped,
           started_at, finished_at, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("01STATS", "memory", 1, 1, 0, 0, 10, 42, '{"status":"completed","error":null}');
    const app = createApp(services);

    const statsResponse = await app.request("/api/clone/stats");
    const stats = (await statsResponse.json()) as {
      total: number;
      quadrants: Record<string, number>;
      tiers: Record<string, number>;
      lastIngestAt: number | null;
      superseded: number;
      unresolvedIngestFailures: number;
    };
    const rejectedExport = await app.request("/api/clone/export");
    const exportResponse = await app.request("/api/clone/export?visibility=public");
    const exported = (await exportResponse.json()) as { cards: Array<Record<string, unknown>> };

    expect(stats.total).toBe(3);
    expect(stats.quadrants["work:public"]).toBe(2);
    expect(stats.quadrants["hobby:sensitive"]).toBe(1);
    expect(stats.tiers).toEqual({ "1": 2, "2": 1 });
    expect(stats.lastIngestAt).toBe(42);
    expect(stats.superseded).toBe(1);
    expect(stats.unresolvedIngestFailures).toBe(0);
    expect(rejectedExport.status).toBe(400);
    expect(exported.cards).toHaveLength(1);
    expect(exported.cards[0]?.id).toBe(alpha.id);
    expect(exported.cards[0]).not.toHaveProperty("sourceRef");
    expect(exported.cards[0]?.visibility).toBe("public");
  });

  it("checks manual public writes and downgrades flagged create or patch content", async () => {
    const app = createApp(services);
    const flaggedCreate = await app.request("/api/clone/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cardInput("work", "public", "private-marker")),
    });
    const flaggedCreated = (await flaggedCreate.json()) as { visibility: string };

    const sensitive = await createCard("work", "sensitive", "transition", "fixture:transition");
    const promotedResponse = await app.request(`/api/clone/cards/${sensitive.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    });
    const promoted = (await promotedResponse.json()) as { visibility: string };

    const safe = await createCard("work", "public", "safe", "fixture:safe");
    const flaggedPatchResponse = await app.request(`/api/clone/cards/${safe.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rationale: "private-marker rationale" }),
    });
    const flaggedPatch = (await flaggedPatchResponse.json()) as { visibility: string };

    expect(flaggedCreate.status).toBe(201);
    expect(flaggedCreated.visibility).toBe("sensitive");
    expect(promotedResponse.status).toBe(200);
    expect(promoted.visibility).toBe("public");
    expect(flaggedPatchResponse.status).toBe(200);
    expect(flaggedPatch.visibility).toBe("sensitive");
    expect(publicCardGate.checked).toHaveLength(4);
  });

  it("returns 400 for malformed, unknown, and semantically invalid request input", async () => {
    const app = createApp(services);
    const malformedResponses = await Promise.all(
      ["/api/clone/query", "/api/clone/cards", "/api/clone/ingest/run"].map((path) =>
        app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      ),
    );
    const misspelledVisibility = await app.request("/api/clone/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "decision", visiblity: "public" }),
    });
    const implicitTierTwo = await app.request("/api/clone/ingest/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sources: ["claude-jsonl"] }),
    });
    // The budget is only a Tier 2 cap, so a Tier 1-only request that supplies
    // one must fail loudly. This is the branch of the schema's superRefine kept
    // when the "budgetFiles is required for tier2" branch was dropped
    // (spec/feature/operations.md section 6); without it, making the budget
    // optional would turn a caller-supplied cap into a silent no-op.
    const budgetWithoutTierTwo = await app.request("/api/clone/ingest/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sources: ["memory"], budgetFiles: 5 }),
    });
    services.ingest.start = () => {
      throw new IngestValidationError("Ingest source is not configured: memory");
    };
    const unconfiguredSource = await app.request("/api/clone/ingest/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sources: ["memory"] }),
    });

    expect(malformedResponses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(misspelledVisibility.status).toBe(400);
    expect(implicitTierTwo.status).toBe(400);
    expect(budgetWithoutTierTwo.status).toBe(400);
    expect(unconfiguredSource.status).toBe(400);
    expect(ingestOptions).toBeNull();
  });

  it("filters queries by controlled-vocabulary categories and rejects unknown values", async () => {
    const filed = await createCard("work", "public", "alpha filed", "fixture:filed", 1, "impl-design");
    await createCard("work", "public", "alpha other", "fixture:other", 1, "writing");
    await createCard("work", "public", "alpha blank", "fixture:blank");
    const app = createApp(services);

    const filtered = await app.request("/api/clone/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "alpha", categories: ["impl-design", "review"], k: 10 }),
    });
    const filteredBody = (await filtered.json()) as { cards: Array<{ id: string }> };
    const unknown = await app.request("/api/clone/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "alpha", categories: ["not-a-category"] }),
    });
    const unknownBatch = await app.request("/api/clone/query-batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: [{ text: "alpha", categories: ["not-a-category"] }] }),
    });
    const emptyCategories = await app.request("/api/clone/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "alpha", categories: [] }),
    });

    expect(filtered.status).toBe(200);
    expect(filteredBody.cards.map((card) => card.id)).toEqual([filed.id]);
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toEqual({ error: "Unknown categories: not-a-category" });
    expect(unknownBatch.status).toBe(400);
    expect(emptyCategories.status).toBe(400);
  });

  it("filters card list and public export by category", async () => {
    const filed = await createCard("work", "public", "alpha filed", "fixture:filed", 1, "impl-design");
    await createCard("work", "public", "alpha other", "fixture:other", 1, "writing");
    const app = createApp(services);

    const listResponse = await app.request("/api/clone/cards?category=impl-design");
    const listed = (await listResponse.json()) as { cards: Array<{ id: string }> };
    const unknownList = await app.request("/api/clone/cards?category=not-a-category");
    const exportResponse = await app.request("/api/clone/export?visibility=public&category=impl-design");
    const exported = (await exportResponse.json()) as { cards: Array<{ id: string; category: string }> };
    const unknownExport = await app.request("/api/clone/export?visibility=public&category=not-a-category");

    expect(listResponse.status).toBe(200);
    expect(listed.cards.map((card) => card.id)).toEqual([filed.id]);
    expect(unknownList.status).toBe(400);
    expect(exportResponse.status).toBe(200);
    expect(exported.cards.map((card) => card.id)).toEqual([filed.id]);
    expect(exported.cards[0]?.category).toBe("impl-design");
    expect(unknownExport.status).toBe(400);
  });

  it("lists seeded categories and creates new ones without exposing DELETE", async () => {
    const app = createApp(services);

    const listResponse = await app.request("/api/clone/categories");
    const listed = (await listResponse.json()) as { categories: Array<{ name: string }> };
    const created = await app.request("/api/clone/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "gamedev", description: "Game design judgments" }),
    });
    const duplicate = await app.request("/api/clone/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "gamedev", description: "Duplicate" }),
    });
    const card = await createCard("work", "public", "alpha game", "fixture:game", 1, "gamedev");

    expect(listResponse.status).toBe(200);
    expect(listed.categories.map((category) => category.name)).toContain("general");
    expect(listed.categories.map((category) => category.name)).toContain("ops-lifecycle");
    expect(created.status).toBe(201);
    expect(duplicate.status).toBe(409);
    expect(card.category).toBe("gamedev");
    expect(
      (await app.request("/api/clone/categories", { method: "DELETE" })).status,
    ).toBe(404);
  });

  it("rejects a sensitive-to-public promotion the gate still flags with 409", async () => {
    const flagged = await createCard(
      "work",
      "sensitive",
      "private-marker content",
      "fixture:flagged-promotion",
    );
    const app = createApp(services);

    const rejected = await app.request(`/api/clone/cards/${flagged.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    });
    const body = (await rejected.json()) as { error: string };
    const unchanged = await (await app.request(`/api/clone/cards/${flagged.id}`)).json() as {
      visibility: string;
    };

    expect(rejected.status).toBe(409);
    expect(body.error).toContain("cannot be promoted to public");
    expect(unchanged.visibility).toBe("sensitive");
    expect(database.prepare("SELECT count(*) AS count FROM clone_card_revisions").get()).toEqual({
      count: 0,
    });
  });

  it("records quadrant and category patches in clone_card_revisions without content", async () => {
    const card = await createCard("work", "sensitive", "audited", "fixture:audited");
    const app = createApp(services);

    const domainPatch = await app.request(`/api/clone/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "hobby", changedBy: "cli" }),
    });
    const categoryPatch = await app.request(`/api/clone/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "workflow" }),
    });
    const textOnlyPatch = await app.request(`/api/clone/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rationale: "updated rationale" }),
    });
    const unknownCategoryPatch = await app.request(`/api/clone/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "not-a-category" }),
    });
    const revisions = database
      .prepare<[string], { changed_fields: string; changed_by: string }>(
        "SELECT changed_fields, changed_by FROM clone_card_revisions WHERE card_id = ? ORDER BY id ASC",
      )
      .all(card.id);

    expect(domainPatch.status).toBe(200);
    expect(categoryPatch.status).toBe(200);
    expect(textOnlyPatch.status).toBe(200);
    expect(unknownCategoryPatch.status).toBe(400);
    expect(revisions).toEqual([
      { changed_fields: '["domain"]', changed_by: "cli" },
      { changed_fields: '["category"]', changed_by: "api" },
    ]);
    for (const revision of revisions) {
      expect(revision.changed_fields).not.toContain("audited");
    }
    // The decoded read path is the only way the trail is inspectable, so it is
    // asserted alongside the raw rows (spec/feature/operations.md Section 2).
    expect(
      cards.listRevisions(card.id).map((revision) => ({
        changedFields: revision.changedFields,
        changedBy: revision.changedBy,
      })),
    ).toEqual([
      { changedFields: ["domain"], changedBy: "cli" },
      { changedFields: ["category"], changedBy: "api" },
    ]);
  });

  async function createCard(
    domain: QueryInput["domain"] & string,
    visibility: QueryInput["visibility"] & string,
    text: string,
    sourceRef: string,
    sourceTier: 1 | 2 = 1,
    category?: string,
  ) {
    return cards.saveWithEmbedding({
      ...cardInput(domain, visibility, text),
      ...(category === undefined ? {} : { category }),
      sourceRef,
      sourceTier,
    });
  }
});

function cardInput(domain: "work" | "hobby", visibility: "public" | "sensitive", text: string) {
  return {
    domain,
    visibility,
    category: null as string | null,
    situation: `${text} situation`,
    judgment: `${text} judgment`,
    rationale: `${text} rationale`,
    tags: [text],
    confidence: 0.9,
  };
}

function vectorFor(text: string): number[] {
  const vector = new Array<number>(DIMENSION).fill(0);
  if (text.includes("alpha")) vector[0] = 1;
  else if (text.includes("beta")) vector[1] = 1;
  else vector[2] = 1;
  return vector;
}
