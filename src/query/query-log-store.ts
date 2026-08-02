import { ulid } from "ulid";
import type { GeniusDatabase } from "../db/database.js";
import type { QueryInput } from "../api/contracts.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export interface QueryLogEntry {
  input: QueryInput;
  /** top1 のセマンティック類似度 (1 / (1 + distance))。候補 0 件なら null。 */
  topSimilarity: number | null;
  resultCount: number;
}

export interface QueryLogRecord {
  id: string;
  text: string;
  domain: string | null;
  visibility: string | null;
  categories: string[] | null;
  topSimilarity: number | null;
  resultCount: number;
  createdAt: number;
}

interface QueryLogRow {
  id: string;
  text: string;
  domain: string | null;
  visibility: string | null;
  categories: string | null;
  top_similarity: number | null;
  result_count: number;
  created_at: number;
}

/**
 * 検索ミス計測 (spec/feature/active-questioning.md §1.2)。生のクエリ文を保存
 * するため、公開 export・カード DTO には決して出さない。保持期間はサーバ起動時
 * と ingest 完了後の `deleteExpired` で強制する (無期限保持を作らない)。
 */
export class SqliteQueryLogStore {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;
  readonly #idFactory: () => string;

  constructor(
    database: GeniusDatabase,
    options: { clock?: () => number; idFactory?: () => string } = {},
  ) {
    this.#database = database;
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory ?? ulid;
  }

  record(entry: QueryLogEntry): void {
    this.#database
      .prepare(
        `INSERT INTO query_log(
           id, text, domain, visibility, categories, top_similarity, result_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#idFactory(),
        entry.input.text,
        entry.input.domain ?? null,
        entry.input.visibility ?? null,
        entry.input.categories === undefined ? null : JSON.stringify(entry.input.categories),
        entry.topSimilarity,
        entry.resultCount,
        this.#clock(),
      );
  }

  /** 期限切れ行を削除し、削除件数を返す。 */
  deleteExpired(retentionDays: number): number {
    if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
      throw new Error("query log retentionDays must be a positive integer");
    }
    const threshold = this.#clock() - retentionDays * MILLISECONDS_PER_DAY;
    return this.#database
      .prepare("DELETE FROM query_log WHERE created_at < ?")
      .run(threshold).changes;
  }

  /** 質問生成 (retrieval-miss 検出) 用の読み出し。WebUI/検出以外から使わない。 */
  list(limit = 100): QueryLogRecord[] {
    // SQLite は負の LIMIT を「無制限」として扱う。生のクエリ文を持つ表なので、
    // 呼び出し側の計算ミスが全件読み出しへ化けないよう入口で弾く。
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("query log list limit must be a positive integer");
    }
    const rows = this.#database
      .prepare<[number], QueryLogRow>(
        "SELECT * FROM query_log ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit);
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      domain: row.domain,
      visibility: row.visibility,
      categories: row.categories === null ? null : (JSON.parse(row.categories) as string[]),
      topSimilarity: row.top_similarity,
      resultCount: row.result_count,
      createdAt: row.created_at,
    }));
  }
}
