import { button, clear, el } from "./dom.js";
import {
  formatCategory,
  formatConfidence,
  formatQuadrant,
  formatTimestamp,
  isRetired,
  summarize,
} from "./format.js";

/**
 * Card list with offset paging. The API returns a page without a total count,
 * so "next" is offered while the page came back full.
 */
export function createCardList({ onSelect, onPage }) {
  const rows = el("div", { className: "card-rows" });
  const summary = el("span", { className: "list-summary" });
  const previous = button("Previous", () => onPage(-1));
  const next = button("Next", () => onPage(1));
  const element = el("section", { className: "panel list-panel" }, [
    el("h2", { textContent: "Cards" }),
    rows,
    el("div", { className: "row pager" }, [previous, next, summary]),
  ]);

  return {
    element,
    render(cards, { offset, limit, selectedId }) {
      clear(rows);
      if (cards.length === 0) {
        rows.append(el("p", { className: "empty", textContent: "No card matches these filters." }));
      }
      for (const card of cards) {
        rows.append(renderRow(card, card.id === selectedId, onSelect));
      }
      previous.disabled = offset === 0;
      next.disabled = cards.length < limit;
      summary.textContent = `${offset + 1}-${offset + cards.length}`;
    },
  };
}

function renderRow(card, isSelected, onSelect) {
  // Retired rows are dimmed as well as badged: with "Include retired" on, the
  // inactive rows must be distinguishable at a glance from the active ones.
  const classNames = ["card-row"];
  if (isSelected) classNames.push("selected");
  if (isRetired(card)) classNames.push("retired");
  const row = el("article", {
    className: classNames.join(" "),
    tabIndex: 0,
  }, [
    el("div", { className: "card-row-head" }, [
      el("span", { className: "badge", textContent: formatQuadrant(card) }),
      el("span", { className: "badge subtle", textContent: formatCategory(card.category) }),
      el("span", { className: "badge subtle", textContent: `conf ${formatConfidence(card.confidence)}` }),
      card.supersededBy === null
        ? null
        : el("span", { className: "badge warn", textContent: "superseded" }),
      isRetired(card)
        ? el("span", { className: "badge retired", textContent: "retired" })
        : null,
    ]),
    el("h3", { className: "card-row-title", textContent: summarize(card.situation, 90) }),
    el("p", { className: "card-row-body", textContent: summarize(card.judgment) }),
    el("p", { className: "card-row-meta", textContent: `${formatTimestamp(card.createdAt)} · ${card.id}` }),
  ]);
  row.addEventListener("click", () => onSelect(card.id));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(card.id);
    }
  });
  return row;
}
