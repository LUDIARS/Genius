import type { Migration } from "./types.js";

interface TableColumnRow {
  name: string;
}

/**
 * 判断者 (decider) をカードと回答に記録する
 * (spec/feature/active-questioning.md §4、2026-09-03 neco 指示)。
 *
 * Genius は「特定の一人の判断」のクローンなので、別人の判断が混ざったカードは
 * コーパスとして不適切になる。これまで回答経路は「Genius 以外の投稿なら誰の返信でも
 * 取り込む」状態で、誰が答えたかを記録する列すら無かった。
 *
 * どちらも NULL 可で追加する:
 * - 既存行は「判断者不明」であり、後から誰かの判断だと決めつけない。
 * - backfill もしない。判断者を偽って埋めるくらいなら不明のまま残す方が安全。
 *
 * 値は Discord の user id (Concordia の chat metadata.discord_user_id) を想定するが、
 * 経路が増えることを見込んで統制語彙にはしない。空文字だけは弾く。
 */
export const questionDeciderMigration: Migration = {
  version: 10,
  name: "decided_by / answered_by for per-user judgment scoping",
  /** @implements SPEC-GENIUS-ACTIVE-QUESTION-ANSWER */
  up(database) {
    // SQLite has no ADD COLUMN IF NOT EXISTS; keep the migration idempotent by hand.
    const hasColumn = (table: string, column: string): boolean =>
      database
        .prepare<[], TableColumnRow>(`PRAGMA table_info('${table}')`)
        .all()
        .some((row) => row.name === column);

    if (!hasColumn("clone_cards", "decided_by")) {
      database.exec(
        `ALTER TABLE clone_cards ADD COLUMN decided_by TEXT NULL
           CHECK (decided_by IS NULL OR length(decided_by) BETWEEN 1 AND 64)`,
      );
    }
    if (!hasColumn("question_answers", "answered_by")) {
      database.exec(
        `ALTER TABLE question_answers ADD COLUMN answered_by TEXT NULL
           CHECK (answered_by IS NULL OR length(answered_by) BETWEEN 1 AND 64)`,
      );
    }

    // 「このユーザーの判断だけ見る」が per-user 管理の主な読み方。判断者不明の行が
    // 当面の大多数なので、004 の retired_at と同じく非 NULL だけを覆う部分索引にする。
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_clone_cards_decided_by
        ON clone_cards(decided_by) WHERE decided_by IS NOT NULL;
    `);
  },
};
