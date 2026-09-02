import { ulid } from "ulid";
import { z } from "zod";
import type { GeniusDatabase } from "../db/database.js";
import { decisionAuthorSchema } from "../domain/card.js";
import {
  answeredViaSchema,
  canonicalCardPairId,
  questionStatusSchema,
  type AnsweredVia,
  type QuestionAnswerRecord,
  type QuestionQueueEntry,
  type QuestionStatus,
  type QuestionTarget,
} from "./types.js";

const answerTextSchema = z.string().trim().min(1).max(16_384);

interface QuestionRow {
  id: string;
  question: string;
  context: string;
  category: string;
  domain: string;
  visibility: string;
  gap_kind: string;
  status: string;
  asked_at: number | null;
  answered_at: number | null;
  discord_message_id: string | null;
  created_at: number;
}

interface AnswerRow {
  id: string;
  question_id: string;
  text: string;
  answered_via: string;
  answered_by: string | null;
  card_id: string | null;
  created_at: number;
}

interface TargetRow {
  question_id: string;
  target_kind: string;
  target_id: string;
}

export class QuestionNotFoundError extends Error {
  constructor(id: string) {
    super(`Question not found: ${id}`);
    this.name = "QuestionNotFoundError";
  }
}

/**
 * Raised when a transition is asked of a question that already left `open`.
 * Answering or dismissing twice is reported rather than silently ignored, so
 * the caller never believes it changed a queue entry that it did not.
 */
export class QuestionNotOpenError extends Error {
  constructor(id: string, status: QuestionStatus) {
    super(`Question ${id} is ${status}, not open`);
    this.name = "QuestionNotOpenError";
  }
}

/**
 * Raised when a prior answer was saved but has not produced a card yet. The
 * same text may be retried idempotently; replacing it would lose the audit
 * trail of what was originally submitted (spec/feature/active-questioning.md §4).
 */
export class QuestionAnswerPendingError extends Error {
  constructor(id: string) {
    super(`Question ${id} already has a saved answer waiting for card creation`);
    this.name = "QuestionAnswerPendingError";
  }
}

export interface ListQuestionsInput {
  status?: QuestionStatus;
  limit: number;
  offset: number;
}

export interface RecordAnswerInput {
  /** 誰の判断か。 同定できない経路は null (§4)。 */
  answeredBy?: string | null;
  questionId: string;
  text: string;
  answeredVia: AnsweredVia;
}

export interface QuestionQueueRepositoryOptions {
  clock?: () => number;
  idFactory?: () => string;
}

/**
 * Read and transition side of the question queue
 * (spec/feature/active-questioning.md §3.1).
 *
 * Creation and cross-run de-duplication stay in QuestionRepository; this class
 * owns what the review UI does with an existing entry: list it, answer it,
 * dismiss it, and attach the card an answer produced.
 *
 * @implements SPEC-GENIUS-ACTIVE-QUESTION-QUEUE
 */
export class QuestionQueueRepository {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;
  readonly #idFactory: () => string;

  /** @implements SPEC-GENIUS-ACTIVE-QUESTION-QUEUE */
  constructor(database: GeniusDatabase, options: QuestionQueueRepositoryOptions = {}) {
    this.#database = database;
    this.#clock = options.clock ?? Date.now;
    this.#idFactory = options.idFactory ?? ulid;
  }

  list(input: ListQuestionsInput): QuestionQueueEntry[] {
    const rows = input.status === undefined
      ? this.#database
        .prepare<[number, number], QuestionRow>(
          `SELECT * FROM questions ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(input.limit, input.offset)
      : this.#database
        .prepare<[string, number, number], QuestionRow>(
          `SELECT * FROM questions WHERE status = ?
             ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(questionStatusSchema.parse(input.status), input.limit, input.offset);
    return this.#hydrate(rows);
  }

  get(id: string): QuestionQueueEntry | null {
    const row = this.#database
      .prepare<[string], QuestionRow>("SELECT * FROM questions WHERE id = ?")
      .get(id);
    if (row === undefined) return null;
    const [entry] = this.#hydrate([row]);
    return entry ?? null;
  }

  /**
   * Open questions that have not been posted to the genius channel yet.
   *
   * visibility では絞らない。 sensitive も専用の `genius` チャンネルへ出す
   * (spec §3.2、2026-09-03 neco 指示)。 public 限定にしていた頃は sensitive が
   * 配信されずキューに滞留し、 `questions.maxOpen` を埋めて新規生成ごと止めていた
   * (実測 open 20/20 中 16 件が sensitive)。
   *
   * Contradiction questions are excluded on purpose: resolving one requires
   * picking a winning card, which only the WebUI offers (§3.1). Posting them
   * would invite replies that cannot be applied.
   *
   * @implements SPEC-GENIUS-ACTIVE-QUESTION-DISCORD
   */
  listUnasked(limit: number): QuestionQueueEntry[] {
    const rows = this.#database
      .prepare<[number], QuestionRow>(
        `SELECT * FROM questions
          WHERE status = 'open' AND asked_at IS NULL
            AND gap_kind <> 'contradiction'
          ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit);
    return this.#hydrate(rows);
  }

  findByDiscordMessageId(discordMessageId: string): QuestionQueueEntry | null {
    const row = this.#database
      .prepare<[string], QuestionRow>("SELECT * FROM questions WHERE discord_message_id = ?")
      .get(discordMessageId);
    if (row === undefined) return null;
    const [entry] = this.#hydrate([row]);
    return entry ?? null;
  }

  /**
   * Oldest `asked_at` still waiting for a reply, or null when nothing is
   * outstanding. Polling from here rather than from a remembered cursor keeps
   * the Discord path correct across restarts.
   */
  earliestOutstandingAskedAt(): number | null {
    const row = this.#database
      .prepare<[], { asked_at: number | null }>(
        `SELECT MIN(asked_at) AS asked_at FROM questions
          WHERE status = 'open' AND asked_at IS NOT NULL`,
      )
      .get();
    return row?.asked_at ?? null;
  }

  /**
   * Stores the reviewer's words verbatim. The card distilled from them is
   * attached later with {@link completeAnswer}, so a failure while distilling
   * never loses the original answer or closes the question. Retrying identical
   * text reuses the pending row and its stable card sourceRef.
   */
  recordAnswer(input: RecordAnswerInput): QuestionAnswerRecord {
    const text = answerTextSchema.parse(input.text);
    const answeredVia = answeredViaSchema.parse(input.answeredVia);
    const answeredBy = input.answeredBy === null || input.answeredBy === undefined
      ? null
      : decisionAuthorSchema.parse(input.answeredBy);
    return this.#database.transaction(() => {
      const status = this.#requireStatus(input.questionId);
      if (status !== "open") throw new QuestionNotOpenError(input.questionId, status);
      const pending = this.#pendingAnswer(input.questionId);
      if (pending !== undefined) {
        if (
          pending.text !== text
          || pending.answered_via !== answeredVia
          || pending.answered_by !== answeredBy
        ) {
          throw new QuestionAnswerPendingError(input.questionId);
        }
        return hydrateAnswer(pending);
      }
      const record: QuestionAnswerRecord = {
        id: this.#idFactory(),
        questionId: input.questionId,
        text,
        answeredVia,
        answeredBy,
        cardId: null,
        createdAt: this.#clock(),
      };
      this.#database
        .prepare(
          `INSERT INTO question_answers(id, question_id, text, answered_via, answered_by, card_id, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          record.id,
          record.questionId,
          record.text,
          record.answeredVia,
          record.answeredBy,
          record.createdAt,
        );
      return record;
    }).immediate();
  }

  /** Atomically links the derived card and closes the question. */
  completeAnswer(answerId: string, cardId: string): QuestionAnswerRecord {
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare<[string], AnswerRow>("SELECT * FROM question_answers WHERE id = ?")
        .get(answerId);
      if (row === undefined) throw new Error(`Question answer not found: ${answerId}`);
      if (row.card_id !== null) {
        if (row.card_id !== cardId) {
          throw new Error(`Question answer ${answerId} is already linked to another card`);
        }
        return hydrateAnswer(row);
      }
      const status = this.#requireStatus(row.question_id);
      if (status !== "open") throw new QuestionNotOpenError(row.question_id, status);
      this.#database
        .prepare("UPDATE question_answers SET card_id = ? WHERE id = ?")
        .run(cardId, answerId);
      this.#database
        .prepare("UPDATE questions SET status = 'answered', answered_at = ? WHERE id = ?")
        .run(this.#clock(), row.question_id);
      return hydrateAnswer({ ...row, card_id: cardId });
    }).immediate();
  }

  dismiss(id: string): void {
    this.#database.transaction(() => {
      const status = this.#requireStatus(id);
      if (status !== "open") throw new QuestionNotOpenError(id, status);
      if (this.#pendingAnswer(id) !== undefined) throw new QuestionAnswerPendingError(id);
      this.#database.prepare("UPDATE questions SET status = 'dismissed' WHERE id = ?").run(id);
    }).immediate();
  }

  markAsked(id: string, discordMessageId: string, askedAt = this.#clock()): void {
    const result = this.#database
      .prepare("UPDATE questions SET asked_at = ?, discord_message_id = ? WHERE id = ?")
      .run(askedAt, discordMessageId, id);
    if (result.changes === 0) throw new QuestionNotFoundError(id);
  }

  #requireStatus(id: string): QuestionStatus {
    const row = this.#database
      .prepare<[string], { status: string }>("SELECT status FROM questions WHERE id = ?")
      .get(id);
    if (row === undefined) throw new QuestionNotFoundError(id);
    return questionStatusSchema.parse(row.status);
  }

  #pendingAnswer(questionId: string): AnswerRow | undefined {
    return this.#database
      .prepare<[string], AnswerRow>(
        `SELECT * FROM question_answers
          WHERE question_id = ? AND card_id IS NULL
          ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get(questionId);
  }

  #hydrate(rows: readonly QuestionRow[]): QuestionQueueEntry[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    const answers = this.#database
      .prepare<string[], AnswerRow>(
        `SELECT * FROM question_answers WHERE question_id IN (${placeholders})
           ORDER BY created_at ASC, id ASC`,
      )
      .all(...ids);
    const targets = this.#database
      .prepare<string[], TargetRow>(
        `SELECT question_id, target_kind, target_id FROM question_targets
          WHERE question_id IN (${placeholders})`,
      )
      .all(...ids);

    const answersByQuestion = new Map<string, QuestionAnswerRecord[]>();
    for (const row of answers) {
      const list = answersByQuestion.get(row.question_id) ?? [];
      list.push(hydrateAnswer(row));
      answersByQuestion.set(row.question_id, list);
    }
    const targetsByQuestion = new Map<string, QuestionTarget[]>();
    const pairByQuestion = new Map<string, [string, string]>();
    for (const row of targets) {
      const list = targetsByQuestion.get(row.question_id) ?? [];
      list.push({ kind: row.target_kind, id: row.target_id } as QuestionTarget);
      targetsByQuestion.set(row.question_id, list);
      if (row.target_kind === "card-pair") {
        pairByQuestion.set(row.question_id, splitCardPairId(row.target_id));
      }
    }

    return rows.map((row) => ({
      id: row.id,
      question: row.question,
      context: row.context,
      category: row.category,
      domain: row.domain as QuestionQueueEntry["domain"],
      visibility: row.visibility as QuestionQueueEntry["visibility"],
      gapKind: row.gap_kind as QuestionQueueEntry["gapKind"],
      status: questionStatusSchema.parse(row.status),
      askedAt: row.asked_at,
      answeredAt: row.answered_at,
      discordMessageId: row.discord_message_id,
      createdAt: row.created_at,
      targets: targetsByQuestion.get(row.id) ?? [],
      answers: answersByQuestion.get(row.id) ?? [],
      pairCardIds: pairByQuestion.get(row.id) ?? null,
    }));
  }
}

function hydrateAnswer(row: AnswerRow): QuestionAnswerRecord {
  return {
    id: row.id,
    questionId: row.question_id,
    text: row.text,
    answeredVia: answeredViaSchema.parse(row.answered_via),
    answeredBy: row.answered_by,
    cardId: row.card_id,
    createdAt: row.created_at,
  };
}

/**
 * Inverse of {@link canonicalCardPairId}. Card ids never contain `:` (they are
 * ULIDs), so a pair id that does not split into exactly two parts is corrupt
 * and is reported rather than half-read.
 */
export function splitCardPairId(pairId: string): [string, string] {
  const parts = pairId.split(":");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new Error(`Malformed card-pair target id: ${pairId}`);
  }
  const canonical = canonicalCardPairId(parts[0], parts[1]);
  if (canonical !== pairId) throw new Error(`Card-pair target id is not canonical: ${pairId}`);
  return [parts[0], parts[1]];
}
