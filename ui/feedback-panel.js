import { button, clear, el } from "./dom.js";
import { formatTimestamp } from "./format.js";

/**
 * 選択中のカードへ評価を送るパネル (spec/feature/card-feedback.md §5)。
 *
 * `not-in-case` は他の 3 つと意味が違う (カードの品質ではなく検索の外れ) ので、
 * ボタンにその説明を出して poor と取り違えられないようにする。
 */
const RATINGS = [
  { value: "great", label: "Great", hint: "この場面の正解だった" },
  { value: "good", label: "Good", hint: "参考として妥当だった" },
  { value: "poor", label: "Poor", hint: "判断が誤っていた (積むとアーカイブされる)" },
  { value: "not-in-case", label: "NotInCase", hint: "場面が違うだけ (アーカイブされない)" },
];

function feedbackEntryElement(entry) {
  return el("div", { className: "feedback-entry" }, [
    el("span", { className: "badge subtle", textContent: entry.rating }),
    el("span", { textContent: entry.source ?? "unknown" }),
    el("span", { className: "muted", textContent: formatTimestamp(entry.createdAt) }),
    entry.note === null
      ? null
      : el("span", { className: "feedback-entry-note", textContent: entry.note }),
  ]);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @implements SPEC-GENIUS-CARD-FEEDBACK-UI */
export function createFeedbackPanel({ onSend }) {
  const summary = el("span", { className: "badge subtle", textContent: "" });
  const note = el("input", {
    type: "text",
    className: "feedback-note",
    placeholder: "note (任意)",
  });
  const history = el("div", { className: "feedback-history" });
  const status = el("span", { className: "feedback-status", textContent: "" });
  let isAvailable = false;
  let isSending = false;

  const buttons = RATINGS.map((rating) =>
    button(rating.label, async () => {
      if (isSending) return;
      isSending = true;
      refreshEnabled();
      status.textContent = "送信中…";
      try {
        await onSend(rating.value, note.value.trim());
        note.value = "";
      } catch (error) {
        status.textContent = `送信できませんでした: ${errorMessage(error)}`;
      } finally {
        isSending = false;
        refreshEnabled();
      }
    }),
  );
  for (const [index, element] of buttons.entries()) element.title = RATINGS[index].hint;

  const element = el("section", { className: "panel feedback-panel" }, [
    el("div", { className: "row" }, [el("h2", { textContent: "Feedback" }), summary]),
    el("div", { className: "row feedback-buttons" }, buttons),
    note,
    status,
    history,
  ]);

  function refreshEnabled() {
    const enabled = isAvailable && !isSending;
    for (const element of buttons) element.disabled = !enabled;
    note.disabled = !enabled;
  }

  refreshEnabled();

  return {
    element,
    renderEmpty() {
      isAvailable = false;
      refreshEnabled();
      summary.textContent = "";
      status.textContent = "カードを選ぶと評価を送れます。";
      clear(history);
    },
    render({ summary: counts, recent, archivedByFeedback = false }) {
      isAvailable = true;
      refreshEnabled();
      summary.textContent =
        `great ${counts.great} · good ${counts.good} · poor ${counts.poor}`
        + ` · not-in-case ${counts.notInCase}`;
      status.textContent = archivedByFeedback
        ? "poor が閾値を超えたのでこのカードはアーカイブされました。"
        : "";
      clear(history);
      for (const entry of recent) {
        history.append(feedbackEntryElement(entry));
      }
    },
  };
}
