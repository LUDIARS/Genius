import * as api from "./api-client.js";
import { createQuestionPanel } from "./question-panel.js";

/**
 * Owns the active-question queue's API operations and panel state. The app
 * controller supplies the one cross-feature effect: refreshing and selecting
 * the card produced by a successful answer.
 *
 * @implements SPEC-GENIUS-ACTIVE-QUESTION-QUEUE
 */
export function createQuestionController({ status, onAnswerApplied, onSelectCard }) {
  const panel = createQuestionPanel({
    onAnswer: (id, text, winnerCardId) => void answer(id, text, winnerCardId),
    onDismiss: (id) => void dismiss(id),
    onRefresh: () => void reload(),
    onSelectCard,
  });

  async function reload() {
    try {
      const body = await api.listQuestions("open");
      panel.render(body.questions);
    } catch (error) {
      status.failure("Failed to load questions", error);
    }
  }

  async function answer(id, text, winnerCardId) {
    let result;
    try {
      result = await api.answerQuestion(id, text, winnerCardId);
    } catch (error) {
      status.failure("Answer rejected", error);
      await reload();
      return;
    }
    status.info(
      result.supersededCardId === null
        ? `Answered ${id} — created card ${result.card.id}`
        : `Answered ${id} — created card ${result.card.id}, superseded ${result.supersededCardId}`,
    );
    await Promise.all([reload(), onAnswerApplied(result.card.id)]);
  }

  async function dismiss(id) {
    try {
      await api.dismissQuestion(id);
      status.info(`Dismissed question ${id}`);
    } catch (error) {
      status.failure("Dismiss rejected", error);
    }
    await reload();
  }

  return {
    element: panel.element,
    async start() {
      panel.renderIdle();
      await reload();
    },
  };
}
