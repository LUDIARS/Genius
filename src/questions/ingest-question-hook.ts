import type {
  IngestCompletionHook,
  IngestRunQuestions,
} from "../ingest/ingest-contracts.js";
import type { SqliteQueryLogStore } from "../query/query-log-store.js";
import type { QuestionGenerationService } from "./question-generation-service.js";

export interface IngestQuestionHookOptions {
  questions: QuestionGenerationService;
  /** null = query_log 無効。有効なら保持期間切れを ingest ごとに落とす。 */
  queryLog?: SqliteQueryLogStore | null;
  retentionDays?: number | null;
  /** null = Discord 経路無効 (Q6)。有効なら生成後に送信と返信取り込みを回す。 */
  relay?: { run(): Promise<{ asked: number; answered: number }> } | null;
  warningSink?: (message: string) => void;
}

/**
 * Q8 — ingest 完了後の後処理 (spec/feature/active-questioning.md §5)。
 *
 * `completed` と `completed-with-errors` の双方で走る。取りこぼしのある run でも
 * 取り込めた分については穴が動いているので、エラーを理由に質問生成を止めない。
 *
 * query_log の保持期間削除もここで行う。起動時の削除だけだと ingest が止まって
 * いる間に保持期間が無制限に伸びる (§1.2)。削除の失敗は質問生成を巻き込まない。
 *
 * @implements SPEC-GENIUS-ACTIVE-QUESTION-INGEST
 */
export class IngestQuestionHook implements IngestCompletionHook {
  readonly #questions: QuestionGenerationService;
  readonly #queryLog: SqliteQueryLogStore | null;
  readonly #retentionDays: number | null;
  readonly #relay: { run(): Promise<{ asked: number; answered: number }> } | null;
  readonly #warningSink: (message: string) => void;

  constructor(options: IngestQuestionHookOptions) {
    this.#questions = options.questions;
    this.#queryLog = options.queryLog ?? null;
    this.#retentionDays = options.retentionDays ?? null;
    this.#relay = options.relay ?? null;
    this.#warningSink = options.warningSink ?? ((message) => process.stderr.write(`${message}\n`));
  }

  async onRunCompleted(): Promise<IngestRunQuestions> {
    this.#pruneQueryLog();
    try {
      const result = await this.#questions.generate();
      return { created: result.created.length, openCount: result.openCount };
    } finally {
      // Existing replies remain useful even when this run could not generate
      // new questions, so collection must not share generation's failure fate.
      await this.#relayToDiscord();
    }
  }

  /**
   * Discord への送信と返信取り込み。ここが失敗しても質問は WebUI に残るので、
   * 生成の結果は返す (片方の経路の障害で両方止めない — §3.2)。
   */
  async #relayToDiscord(): Promise<void> {
    if (this.#relay === null) return;
    try {
      const { asked, answered } = await this.#relay.run();
      if (asked > 0 || answered > 0) {
        this.#warningSink(`[questions] Discord: asked ${asked}, answered ${answered}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#warningSink(`[questions] Discord relay failed: ${detail}`);
    }
  }

  #pruneQueryLog(): void {
    if (this.#queryLog === null || this.#retentionDays === null) return;
    try {
      const deleted = this.#queryLog.deleteExpired(this.#retentionDays);
      if (deleted > 0) {
        this.#warningSink(`[query-log] deleted ${deleted} entries past ${this.#retentionDays} days`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#warningSink(`[query-log] retention delete failed after ingest: ${detail}`);
    }
  }
}
