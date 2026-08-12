import type {
  AnswerQuestionInput,
  AnswerQuestionResult,
  QuestionAnswerService,
} from "../questions/question-answer-service.js";
import type {
  ListQuestionsInput,
  QuestionQueueRepository,
} from "../questions/question-queue-repository.js";
import type { QuestionQueueEntry } from "../questions/types.js";

/**
 * Adapts the synchronous SQLite queue and the asynchronous answer pipeline to
 * the API service shape. Reads stay on the repository; anything that writes a
 * card goes through QuestionAnswerService so the curation rules (§4) apply on
 * every path, not just the HTTP one.
 *
 * @implements SPEC-GENIUS-ACTIVE-QUESTION-QUEUE
 */
export class QuestionQueueService {
  readonly #answers: QuestionAnswerService;
  readonly #queue: QuestionQueueRepository;

  constructor(queue: QuestionQueueRepository, answers: QuestionAnswerService) {
    this.#queue = queue;
    this.#answers = answers;
  }

  async list(input: ListQuestionsInput): Promise<QuestionQueueEntry[]> {
    return this.#queue.list(input);
  }

  async get(id: string): Promise<QuestionQueueEntry | null> {
    return this.#queue.get(id);
  }

  async answer(input: AnswerQuestionInput): Promise<AnswerQuestionResult> {
    return this.#answers.answer(input);
  }

  async dismiss(id: string): Promise<QuestionQueueEntry> {
    return this.#answers.dismiss(id);
  }
}
