import { describe, expect, it, afterEach } from "vitest";
import { openDatabase, runMigrations } from "../src/db/index.js";
import type { GeniusDatabase } from "../src/db/database.js";
import { SqliteQueryLogStore } from "../src/query/query-log-store.js";
import { QueryService, type QueryVectorPort } from "../src/query/query-service.js";
import { createQueryLogStore } from "../src/query/create-query-log-store.js";
import type { CloneCard } from "../src/domain/card.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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

function card(id: string): CloneCard {
  const now = 1_000;
  return {
    id,
    domain: "work",
    visibility: "sensitive",
    category: null,
    situation: "synthetic situation",
    judgment: "synthetic judgment",
    rationale: "synthetic rationale",
    tags: [],
    confidence: 0.5,
    sourceRef: `test:${id}`,
    sourceTier: 1,
    decidedBy: null,
    supersededBy: null,
    retiredAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function vectorPortReturning(distances: readonly number[]): QueryVectorPort {
  return {
    search: () =>
      distances.map((distance, index) => ({ card: card(`card-${index}`), distance })),
  };
}

const embedder = { embed: async (texts: readonly string[]) => texts.map(() => [0.1, 0.2]) };

describe("SqliteQueryLogStore", () => {
  it("records the query with filters and enforces the retention window", () => {
    const database = migratedDatabase();
    let now = 100 * DAY_MS;
    const store = new SqliteQueryLogStore(database, { clock: () => now });

    store.record({
      input: { text: "how to branch", k: 8, domain: "work", categories: ["workflow"] },
      topSimilarity: 0.42,
      resultCount: 8,
    });
    now += 5 * DAY_MS;
    store.record({
      input: { text: "recent query", k: 8 },
      topSimilarity: null,
      resultCount: 0,
    });

    const before = store.list();
    expect(before).toHaveLength(2);
    expect(before[1]).toMatchObject({
      text: "how to branch",
      domain: "work",
      visibility: null,
      categories: ["workflow"],
      topSimilarity: 0.42,
      resultCount: 8,
    });

    // 30 日より古い 1 件目だけが消える (今は record 時刻 + 5 日 + 26 日)。
    now += 26 * DAY_MS;
    expect(store.deleteExpired(30)).toBe(1);
    const after = store.list();
    expect(after).toHaveLength(1);
    expect(after[0]?.text).toBe("recent query");
  });

  // visibility 列は CHECK ('public' | 'sensitive') 付きなので、実際に値が入る
  // 経路を 1 本通しておく (null しか通らない配線ミスをテストで拾う)。
  it("persists the visibility filter through the CHECK-constrained column", () => {
    const store = new SqliteQueryLogStore(migratedDatabase());
    store.record({
      input: { text: "sensitive lookup", k: 4, visibility: "sensitive" },
      topSimilarity: 0.9,
      resultCount: 4,
    });
    expect(store.list()[0]).toMatchObject({ visibility: "sensitive", domain: null });
  });

  it("rejects a non-positive retention", () => {
    const store = new SqliteQueryLogStore(migratedDatabase());
    expect(() => store.deleteExpired(0)).toThrowError(/positive integer/);
  });

  // SQLite の LIMIT -1 は「無制限」。生のクエリ文の全件読み出しへ化けないこと。
  it("rejects a non-positive list limit", () => {
    const store = new SqliteQueryLogStore(migratedDatabase());
    expect(() => store.list(-1)).toThrowError(/positive integer/);
    expect(() => store.list(0)).toThrowError(/positive integer/);
  });
});

describe("QueryService query logging", () => {
  it("records every query with the top semantic similarity", async () => {
    const database = migratedDatabase();
    const store = new SqliteQueryLogStore(database, { clock: () => 1_000 });
    const service = new QueryService({
      embedder,
      vectors: vectorPortReturning([0.25, 1.0]),
      queryLog: store,
    });

    const result = await service.query({ text: "find the rule", k: 1 });

    expect(result.cards).toHaveLength(1);
    const logged = store.list();
    expect(logged).toHaveLength(1);
    // 類似度は blend 済みスコアではなく 1 / (1 + 最小 distance)。
    expect(logged[0]?.topSimilarity).toBeCloseTo(1 / 1.25, 10);
    // result_count は k で切り詰めた後の返却件数。
    expect(logged[0]?.resultCount).toBe(1);
  });

  it("records a zero-hit query with a null similarity", async () => {
    const database = migratedDatabase();
    const store = new SqliteQueryLogStore(database);
    const service = new QueryService({
      embedder,
      vectors: vectorPortReturning([]),
      queryLog: store,
    });

    await service.query({ text: "nothing matches", k: 8 });

    expect(store.list()[0]).toMatchObject({ topSimilarity: null, resultCount: 0 });
  });

  it("does not fail the query when recording breaks, but warns", async () => {
    const warnings: string[] = [];
    const service = new QueryService({
      embedder,
      vectors: vectorPortReturning([0.5]),
      queryLog: {
        record: () => {
          throw new Error("query_log is gone");
        },
      },
      warningSink: (message) => warnings.push(message),
    });

    const result = await service.query({ text: "still works", k: 1 });

    expect(result.cards).toHaveLength(1);
    expect(warnings.some((message) => message.includes("Query log record failed"))).toBe(true);
  });

  it("does not record when the log port is absent", async () => {
    const service = new QueryService({ embedder, vectors: vectorPortReturning([0.5]) });
    await expect(service.query({ text: "no log", k: 1 })).resolves.toBeTruthy();
  });
});

describe("createQueryLogStore (startup wiring)", () => {
  function seedExpiredAndFresh(database: GeniusDatabase): void {
    const insert = database.prepare(
      `INSERT INTO query_log(id, text, result_count, created_at) VALUES (?, ?, 0, ?)`,
    );
    insert.run("old", "expired query", Date.now() - 90 * DAY_MS);
    insert.run("new", "fresh query", Date.now());
  }

  it("enforces the retention window at startup and reports the deletion", () => {
    const database = migratedDatabase();
    seedExpiredAndFresh(database);
    const messages: string[] = [];

    const store = createQueryLogStore({ enabled: true, retentionDays: 30 }, database, (message) =>
      messages.push(message),
    );

    expect(store).not.toBeNull();
    expect(store?.list().map((entry) => entry.id)).toEqual(["new"]);
    expect(messages.join("")).toContain("deleted 1 expired entries");
  });

  // 記録を止めただけで過去の生クエリ文が無期限に残る面を作らない (spec §1.2)。
  // 無効化は許容するが無言にはしない (CLAUDE.md「無言フォールバック禁止」)。
  it("still enforces the retention window when logging is disabled, and says so", () => {
    const database = migratedDatabase();
    seedExpiredAndFresh(database);
    const messages: string[] = [];

    expect(
      createQueryLogStore({ enabled: false, retentionDays: 30 }, database, (message) =>
        messages.push(message),
      ),
    ).toBeNull();

    expect(new SqliteQueryLogStore(database).list().map((entry) => entry.id)).toEqual(["new"]);
    expect(messages.join("")).toContain("query logging is disabled");
  });
});

describe("questions tables (migrations 006 + 007)", () => {
  it("rejects values outside the controlled vocabularies", () => {
    const database = migratedDatabase();
    const insertQuestion = database.prepare(
      `INSERT INTO questions(id, question, context, category, domain, visibility, gap_kind, created_at)
       VALUES (?, ?, ?, 'general', 'work', 'sensitive', ?, 0)`,
    );
    expect(() => insertQuestion.run("q-1", "q?", "ctx", "low-confidence")).not.toThrow();
    expect(() => insertQuestion.run("q-2", "q?", "ctx", "not-a-gap")).toThrowError(/CHECK/);

    const insertTarget = database.prepare(
      `INSERT INTO question_targets(id, question_id, target_kind, target_id)
       VALUES (?, 'q-1', ?, ?)`,
    );
    expect(() => insertTarget.run("t-1", "card", "card-a")).not.toThrow();
    // 同じ dedupe 対象を再質問しない: partial UNIQUE (target_kind, target_id)。
    expect(() => insertTarget.run("t-2", "card", "card-a")).toThrowError(/UNIQUE/);
    expect(() => insertTarget.run("t-3", "spreadsheet", "x")).toThrowError(/CHECK/);

    const insertAnswer = database.prepare(
      `INSERT INTO question_answers(id, question_id, text, answered_via, created_at)
       VALUES (?, 'q-1', 'answer', ?, 0)`,
    );
    expect(() => insertAnswer.run("a-1", "ui")).not.toThrow();
    expect(() => insertAnswer.run("a-2", "email")).toThrowError(/CHECK/);
  });
});
