import { clear, el } from "./dom.js";
import {
  formatCategory,
  formatConfidence,
  formatQuadrant,
  formatTimestamp,
  isRetired,
  summarize,
} from "./format.js";

/** Read-only card detail: full text, sourceRef, and the supersede chain. */
export function createCardDetail({ onSelect }) {
  const element = el("section", { className: "panel detail-panel" });

  function renderEmpty() {
    clear(element);
    element.append(el("p", { className: "empty", textContent: "Select a card to inspect it." }));
  }

  renderEmpty();

  return {
    element,
    render(card, chain) {
      clear(element);
      element.append(
        el("h2", { textContent: "Detail" }),
        el("div", { className: "row badges" }, [
          el("span", { className: "badge", textContent: formatQuadrant(card) }),
          el("span", { className: "badge subtle", textContent: formatCategory(card.category) }),
          el("span", { className: "badge subtle", textContent: `conf ${formatConfidence(card.confidence)}` }),
          el("span", { className: "badge subtle", textContent: `tier ${card.sourceTier}` }),
          card.supersededBy === null
            ? null
            : el("span", { className: "badge warn", textContent: "superseded" }),
          isRetired(card)
            ? el("span", { className: "badge retired", textContent: "retired" })
            : null,
        ]),
        textBlock("Situation", card.situation),
        textBlock("Judgment", card.judgment),
        textBlock("Rationale", card.rationale),
        metaList(card),
        renderChain(chain, onSelect),
      );
    },
  };
}

function textBlock(label, value) {
  return el("div", { className: "text-block" }, [
    el("h4", { textContent: label }),
    el("p", { className: "card-text", textContent: value }),
  ]);
}

function metaList(card) {
  const entries = [
    ["id", card.id],
    ["sourceRef", card.sourceRef],
    ["tags", card.tags.length === 0 ? "(none)" : card.tags.join(", ")],
    ["created", formatTimestamp(card.createdAt)],
    ["updated", formatTimestamp(card.updatedAt)],
    ["supersededBy", card.supersededBy ?? "(none)"],
    ["retiredAt", isRetired(card) ? formatTimestamp(card.retiredAt) : "(not retired)"],
  ];
  const list = el("dl", { className: "meta" });
  for (const [key, value] of entries) {
    list.append(el("dt", { textContent: key }), el("dd", { textContent: String(value) }));
  }
  return list;
}

function renderChain(chain, onSelect) {
  const section = el("div", { className: "chain" }, [el("h4", { textContent: "Supersede chain" })]);
  if (chain === null) {
    section.append(el("p", { className: "hint", textContent: "Chain unavailable." }));
    return section;
  }
  section.append(
    chainGroup("Replaced by this card", chain.supersedes, onSelect),
    chainGroup("Replacements of this card", chain.supersededBy, onSelect),
  );
  return section;
}

function chainGroup(label, cards, onSelect) {
  const group = el("div", { className: "chain-group" }, [el("h5", { textContent: label })]);
  if (cards.length === 0) {
    group.append(el("p", { className: "hint", textContent: "(none)" }));
    return group;
  }
  const list = el("ul", { className: "chain-list" });
  for (const card of cards) {
    const link = el("button", {
      className: "link-button",
      type: "button",
      textContent: `${card.id} — ${summarize(card.situation, 60)}`,
    });
    link.addEventListener("click", () => onSelect(card.id));
    list.append(el("li", {}, [link]));
  }
  group.append(list);
  return group;
}
