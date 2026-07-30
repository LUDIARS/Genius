import type { Migration } from "./types.js";

/**
 * 文書単位のエラー隔離 (spec/feature/operations.md §4)。
 * 増分カーソルが失敗文書を追い越しても再処理できるよう、失敗を永続化する。
 * 本文は保存しない (locator はソース相対パス / API キーのみ)。
 */
export const ingestFailuresMigration: Migration = {
  version: 2,
  name: "ingest failure persistence",
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS ingest_failures (
        source TEXT NOT NULL CHECK (
          source IN (
            'memory',
            'session-logs',
            'channel-archives',
            'review',
            'memoria',
            'claude-jsonl',
            'codex-jsonl'
          )
        ),
        locator TEXT NOT NULL CHECK (length(trim(locator)) > 0),
        mtime_ms INTEGER NOT NULL CHECK (mtime_ms >= 0),
        -- reader 私有の安定 ID (review の manifest locator / Memoria の API パス)。
        -- 無いと review / memoria の readDocument が retry 時に必ず落ちる。
        native_id TEXT NULL,
        run_id TEXT NOT NULL,
        error_kind TEXT NOT NULL CHECK (length(trim(error_kind)) > 0),
        error_message TEXT NOT NULL,
        failed_at INTEGER NOT NULL,
        resolved_at INTEGER NULL,
        PRIMARY KEY (source, locator)
      );

      CREATE INDEX IF NOT EXISTS idx_ingest_failures_unresolved
        ON ingest_failures(source) WHERE resolved_at IS NULL;
    `);
  },
};
