import type { Migration } from "./types.js";

export const initialMigration: Migration = {
  version: 1,
  name: "initial clone-card schema",
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS clone_cards (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL CHECK (domain IN ('work', 'hobby')),
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'sensitive')),
        situation TEXT NOT NULL CHECK (length(trim(situation)) > 0),
        judgment TEXT NOT NULL CHECK (length(trim(judgment)) > 0),
        rationale TEXT NOT NULL CHECK (length(trim(rationale)) > 0),
        tags TEXT NOT NULL CHECK (json_valid(tags) AND json_type(tags) = 'array'),
        source_ref TEXT NOT NULL CHECK (length(trim(source_ref)) > 0),
        source_tier INTEGER NOT NULL CHECK (source_tier IN (1, 2)),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        superseded_by TEXT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_clone_cards_domain_visibility
        ON clone_cards(domain, visibility);
      CREATE INDEX IF NOT EXISTS idx_clone_cards_superseded_by
        ON clone_cards(superseded_by);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_clone_cards_source_ref
        ON clone_cards(source_ref);

      CREATE VIRTUAL TABLE IF NOT EXISTS clone_vec USING vec0(
        card_id TEXT PRIMARY KEY,
        embedding float[1024]
      );

      CREATE TABLE IF NOT EXISTS embedding_meta (
        model TEXT PRIMARY KEY,
        dim INTEGER NOT NULL CHECK (dim > 0),
        is_active INTEGER NOT NULL CHECK (is_active IN (0, 1))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_meta_one_active
        ON embedding_meta(is_active) WHERE is_active = 1;

      CREATE TABLE IF NOT EXISTS embedding_cache (
        model TEXT NOT NULL,
        dim INTEGER NOT NULL CHECK (dim > 0),
        format_version INTEGER NOT NULL CHECK (format_version > 0),
        text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
        embedding BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (model, dim, format_version, text_sha256)
      );

      CREATE TABLE IF NOT EXISTS ingest_state (
        source TEXT PRIMARY KEY CHECK (
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
        cursor TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS distill_runs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        files_processed INTEGER NOT NULL DEFAULT 0,
        cards_created INTEGER NOT NULL DEFAULT 0,
        cards_merged INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NULL,
        notes TEXT NULL
      );
    `);
  },
};
