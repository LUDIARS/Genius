import type { Migration } from "./types.js";

/**
 * `query_log` — 検索ミス計測 (spec/feature/active-questioning.md §1.2)。
 *
 * 判断ではなく生のクエリ文なのでカードとは扱いを分ける: 公開 export に
 * 含めない・カード DTO に出さない・保持期間付き (queryLog.retentionDays) で
 * 起動時と ingest 完了後に期限切れを削除する。
 */
export const queryLogMigration: Migration = {
  version: 5,
  name: "query_log for retrieval-miss measurement",
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS query_log (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        domain TEXT NULL CHECK (domain IN ('work', 'hobby')),
        visibility TEXT NULL CHECK (visibility IN ('public', 'sensitive')),
        categories TEXT NULL,
        top_similarity REAL NULL,
        result_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      -- 保持期間削除と retrieval-miss 検出 (top_similarity の低い順) の両方が
      -- created_at 範囲で絞るので、時系列の索引だけ張る。
      CREATE INDEX IF NOT EXISTS idx_query_log_created_at ON query_log(created_at);
    `);
  },
};
