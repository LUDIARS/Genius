import type { Migration } from "./types.js";

/**
 * 補完質問 (能動学習) の 3 テーブル (spec/feature/active-questioning.md §2.1)。
 *
 * - `questions`: 生成された質問。visibility はカードと同じ二重チェックゲートを
 *   通った値。矛盾質問以外は専用の Genius channel へ出せる。
 * - `question_targets`: 質問の根拠 (カード / カードペア / query_log)。
 *   `UNIQUE (target_kind, target_id)` が「同じ対象を再質問しない」の実体。
 * - `question_answers`: 回答。1 質問に複数回答が付きうる。
 *
 * 統制語彙 (gap_kind / status / target_kind / answered_via) は CHECK で
 * fail-fast にする (category の DB トリガと同じ「無言で通さない」扱い)。
 */
export const questionsMigration: Migration = {
  version: 6,
  name: "questions / question_targets / question_answers for active questioning",
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        context TEXT NOT NULL,
        category TEXT NOT NULL REFERENCES card_categories(name),
        domain TEXT NOT NULL CHECK (domain IN ('work', 'hobby')),
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'sensitive')),
        gap_kind TEXT NOT NULL CHECK (gap_kind IN (
          'low-confidence', 'contradiction', 'category-gap', 'retrieval-miss', 'curation'
        )),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'dismissed')),
        asked_at INTEGER NULL,
        answered_at INTEGER NULL,
        discord_message_id TEXT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);

      CREATE TABLE IF NOT EXISTS question_targets (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL REFERENCES questions(id),
        target_kind TEXT NOT NULL CHECK (target_kind IN ('card', 'card-pair', 'query_log')),
        target_id TEXT NOT NULL,
        UNIQUE (target_kind, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_question_targets_question_id
        ON question_targets(question_id);

      CREATE TABLE IF NOT EXISTS question_answers (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL REFERENCES questions(id),
        text TEXT NOT NULL,
        answered_via TEXT NOT NULL CHECK (answered_via IN ('ui', 'discord')),
        card_id TEXT NULL REFERENCES clone_cards(id),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_question_answers_question_id
        ON question_answers(question_id);
    `);
  },
};
