import { button, clear, el } from "./dom.js";
import { formatTimestamp, summarize } from "./format.js";

/**
 * Question queue (spec/feature/active-questioning.md §3.1). Loopback-only, so
 * sensitive questions are shown in full.
 *
 * A contradiction question cannot be answered without picking a winner, so the
 * winner radios gate the answer button rather than letting the server refuse
 * the write after the reviewer has typed an answer.
 *
 * @implements SPEC-GENIUS-ACTIVE-QUESTION-QUEUE
 */
export function createQuestionPanel({ onAnswer, onDismiss, onRefresh, onSelectCard }) {
  const rows = el("div", { className: "question-rows" });
  const summary = el("span", { className: "list-summary" });
  const element = el("section", { className: "panel question-panel" }, [
    el("div", { className: "row" }, [
      el("h2", { textContent: "Questions" }),
      button("Refresh", () => onRefresh()),
      summary,
    ]),
    rows,
  ]);

  return {
    element,
    renderIdle() {
      clear(rows);
      rows.append(el("p", { className: "empty", textContent: "Press Refresh to load open questions." }));
      summary.textContent = "";
    },
    render(questions) {
      clear(rows);
      summary.textContent = `${questions.length} open`;
      if (questions.length === 0) {
        rows.append(el("p", { className: "empty", textContent: "No open questions." }));
        return;
      }
      for (const question of questions) {
        rows.append(renderQuestion(question, { onAnswer, onDismiss, onSelectCard }));
      }
    },
  };
}

/** @implements SPEC-GENIUS-ACTIVE-QUESTION-QUEUE */
function renderQuestion(question, { onAnswer, onDismiss, onSelectCard }) {
  const pendingAnswer = question.answers.find((answer) => answer.cardId === null) ?? null;
  const answerInput = el("textarea", {
    className: "question-answer",
    rows: 3,
    placeholder: "Your answer",
    value: pendingAnswer?.text ?? "",
  });
  const isContradiction = question.gapKind === "contradiction" && question.pairCardIds !== null;
  const winner = isContradiction ? renderWinnerChoice(question, onSelectCard) : null;
  const submit = button("Answer", () => {
    const text = answerInput.value.trim();
    if (text === "") return;
    onAnswer(question.id, text, winner === null ? null : winner.selected());
  }, "button primary");
  if (winner !== null) {
    submit.disabled = true;
    winner.onChange(() => { submit.disabled = winner.selected() === null; });
  }
  const dismiss = button("Dismiss", () => onDismiss(question.id));
  dismiss.disabled = pendingAnswer !== null;

  return el("article", { className: "question-row" }, [
    el("div", { className: "card-row-head" }, [
      el("span", { className: "badge", textContent: question.gapKind }),
      el("span", { className: "badge subtle", textContent: question.category }),
      el("span", {
        className: question.visibility === "public" ? "badge subtle" : "badge warn",
        textContent: `${question.domain} / ${question.visibility}`,
      }),
      question.discordMessageId === null
        ? null
        : el("span", { className: "badge subtle", textContent: "asked on Discord" }),
    ]),
    el("h3", { className: "card-row-title", textContent: question.question }),
    el("p", { className: "card-row-body", textContent: question.context }),
    pendingAnswer === null
      ? null
      : el("p", {
        className: "card-row-meta",
        textContent: "Answer saved; submit it again to retry card creation.",
      }),
    winner === null ? null : winner.element,
    answerInput,
    el("div", { className: "row" }, [
      submit,
      dismiss,
      el("span", { className: "card-row-meta", textContent: formatTimestamp(question.createdAt) }),
    ]),
  ]);
}

/**
 * Radio pair for "which of these two judgments is the right one". The losing
 * card is superseded by the card the answer produces, so the choice is recorded
 * as part of the answer rather than as a separate edit.
 */
/** @implements SPEC-GENIUS-ACTIVE-QUESTION-QUEUE */
function renderWinnerChoice(question, onSelectCard) {
  const name = `winner-${question.id}`;
  const listeners = [];
  const inputs = question.pairCardIds.map((cardId) => {
    const input = el("input", { type: "radio", name, value: cardId });
    input.addEventListener("change", () => { for (const listener of listeners) listener(); });
    return el("div", { className: "winner-option" }, [
      el("label", { className: "winner-label" }, [
        input,
        el("span", { textContent: summarize(cardId, 40) }),
      ]),
      button("open", () => onSelectCard(cardId), "button link"),
    ]);
  });
  const element = el("div", { className: "winner-choice" }, [
    el("span", { className: "field-label", textContent: "Which one is right?" }),
    ...inputs,
  ]);
  return {
    element,
    selected() {
      const checked = element.querySelector("input:checked");
      return checked === null ? null : checked.value;
    },
    onChange(listener) { listeners.push(listener); },
  };
}
