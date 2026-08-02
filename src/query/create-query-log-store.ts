import type { QueryLogConfig } from "../config/types.js";
import type { GeniusDatabase } from "../db/database.js";
import { SqliteQueryLogStore } from "./query-log-store.js";

/**
 * 検索ミス計測の起動配線 (spec/feature/active-questioning.md §1.2)。
 *
 * 無効化は許容するが無言にはしない (notify と同じ扱い)。有効なら起動時に必ず
 * 保持期間を強制する — ingest 完了後の削除は別途足すが、ingest が止まっている
 * 間に保持期間が無制限へ伸びる面はこの起動時削除が塞ぐ。
 *
 * createRuntime ではなく query 側に置く: 依存は `queryLog` 節と DB だけで、
 * Ollama/蒸留 backend の疎通を必要としない (起動時削除は spec 上必須なので
 * 単体で検証できる形にしておく)。
 */
export function createQueryLogStore(
  queryLog: QueryLogConfig,
  database: GeniusDatabase,
  warningSink: (message: string) => void = (message) => process.stderr.write(message),
): SqliteQueryLogStore | null {
  const store = new SqliteQueryLogStore(database);
  // 保持期間は「これから記録するか」とは独立に強制する。enabled を false へ
  // 倒しただけで既存の生クエリ文が無期限に残る面を作らない
  // (spec/feature/active-questioning.md §1.2「無期限保持はしない」)。
  const deleted = store.deleteExpired(queryLog.retentionDays);
  if (deleted > 0) {
    warningSink(`[query-log] deleted ${deleted} expired entries\n`);
  }
  if (!queryLog.enabled) {
    warningSink("[query-log] query logging is disabled (queryLog.enabled is false)\n");
    return null;
  }
  return store;
}
