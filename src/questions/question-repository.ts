import { ulid } from "ulid";
import { z } from "zod";
import type { GeniusDatabase } from "../db/database.js";
import { categoryNameSchema } from "../domain/category.js";
import { domainSchema, visibilitySchema } from "../domain/card.js";
import {
  gapKindSchema,
  questionTargetKindSchema,
  type GeneratedQuestion,
  type QuestionRecord,
  type QuestionTarget,
} from "./types.js";

const questionTextSchema = z.string().trim().min(1).max(16_384);
const targetIdSchema = z.string().trim().min(1).max(4_096);
/**
 * 再質問しない対象の種別。migration 007 の部分 UNIQUE index
 * `idx_question_targets_dedupe` の WHERE 句と同じ集合であること
 * (`card-context` は矛盾質問の表示根拠なので重複可)。
 */
const DEDUPE_TARGET_KINDS = new Set(["card", "card-pair", "query_log", "category"]);

export class QuestionCapacityError extends Error {
  constructor(maxOpen: number) {
    super(`Question queue already reached maxOpen=${maxOpen}`);
    this.name = "QuestionCapacityError";
  }
}

export class QuestionTargetAlreadyAskedError extends Error {
  constructor(target: QuestionTarget) {
    super(`Question target was already asked: ${target.kind}:${target.id}`);
    this.name = "QuestionTargetAlreadyAskedError";
  }
}

export interface QuestionRepositoryOptions {
  clock?: () => number;
  idFactory?: () => string;
}

/**
 * 質問キューの永続化 (spec/feature/active-questioning.md §2.1)。
 * maxOpen 判定と対象の重複排除は同一トランザクション内で行い、
 * 上限超過・既出対象は無言スキップせず専用エラーで返す。
 */
export class QuestionRepository {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;
  readonly #idFactory: () => string;

  constructor(database: GeniusDatabase, options: QuestionRepositoryOptions = {}) {
    this.#database = database;
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory ?? ulid;
  }

  openCount(): number {
    const row = this.#database
      .prepare<[], { count: number }>("SELECT count(*) AS count FROM questions WHERE status = 'open'")
      .get();
    if (!row) throw new Error("Question count query returned no row");
    return row.count;
  }

  hasTarget(target: QuestionTarget): boolean {
    const normalized = normalizeTarget(target);
    if (!DEDUPE_TARGET_KINDS.has(normalized.kind)) return false;
    return this.#database
      .prepare<[string, string], { one: number }>(
        "SELECT 1 AS one FROM question_targets WHERE target_kind = ? AND target_id = ? LIMIT 1",
      )
      .get(normalized.kind, normalized.id) !== undefined;
  }

  createOpen(input: GeneratedQuestion, maxOpen: number): QuestionRecord {
    if (!Number.isSafeInteger(maxOpen) || maxOpen <= 0) {
      throw new Error("maxOpen must be a positive integer");
    }
    const normalized = normalizeQuestion(input);
    const record: QuestionRecord = {
      ...normalized,
      id: this.#idFactory(),
      status: "open",
      askedAt: null,
      answeredAt: null,
      discordMessageId: null,
      createdAt: this.#clock(),
    };

    return this.#database.transaction(() => {
      if (this.openCount() >= maxOpen) throw new QuestionCapacityError(maxOpen);
      for (const target of normalized.targets) {
        if (this.hasTarget(target)) throw new QuestionTargetAlreadyAskedError(target);
      }
      this.#database
        .prepare(
          `INSERT INTO questions(
             id, question, context, category, domain, visibility, gap_kind, status,
             asked_at, answered_at, discord_message_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, ?)`,
        )
        .run(
          record.id,
          record.question,
          record.context,
          record.category,
          record.domain,
          record.visibility,
          record.gapKind,
          record.createdAt,
        );
      const insertTarget = this.#database.prepare(
        `INSERT INTO question_targets(id, question_id, target_kind, target_id)
         VALUES (?, ?, ?, ?)`,
      );
      for (const target of normalized.targets) {
        insertTarget.run(this.#idFactory(), record.id, target.kind, target.id);
      }
      return record;
    }).immediate();
  }
}

function normalizeQuestion(input: GeneratedQuestion): GeneratedQuestion {
  if (input.targets.length === 0) throw new Error("Question must have at least one target");
  const targets = input.targets.map(normalizeTarget);
  const unique = new Set(targets.map((target) => `${target.kind}\0${target.id}`));
  if (unique.size !== targets.length) throw new Error("Question targets must be unique within a question");
  return {
    question: questionTextSchema.parse(input.question),
    context: questionTextSchema.parse(input.context),
    category: categoryNameSchema.parse(input.category),
    domain: domainSchema.parse(input.domain),
    visibility: visibilitySchema.parse(input.visibility),
    gapKind: gapKindSchema.parse(input.gapKind),
    targets,
  };
}

function normalizeTarget(target: QuestionTarget): QuestionTarget {
  return {
    kind: questionTargetKindSchema.parse(target.kind),
    id: targetIdSchema.parse(target.id),
  };
}
