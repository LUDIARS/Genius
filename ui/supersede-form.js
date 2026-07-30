import { button, el, field } from "./dom.js";

/**
 * Replaces the selected card with another card.
 *
 * There is no DELETE: this panel points `superseded_by` at the replacement,
 * which removes the old card from list, query and export results. Two routes
 * are offered — link an existing card, or author a replacement now (created
 * first, then linked). Deactivating a card with *no* replacement is a different
 * operation and lives in the Retire panel; the two are independent server-side.
 */
export function createSupersedeForm({ onLinkExisting, onReplaceWithNew, onUnlink }) {
  const replacementId = el("input", { type: "text", placeholder: "replacement card id" });
  const state = el("p", { className: "hint" });
  let card = null;

  const element = el("section", { className: "panel supersede-panel" }, [
    el("h3", { textContent: "Supersede" }),
    state,
    field("Replacement card id", replacementId),
    el("div", { className: "row" }, [
      button("Replace with this card", () => onLinkExisting(replacementId.value.trim()), "button primary"),
      button("Replace with a new card", () => onReplaceWithNew()),
      button("Clear supersede link", () => onUnlink()),
    ]),
  ]);

  return {
    element,
    setCard(next) {
      card = next;
      replacementId.value = "";
      state.textContent =
        card.supersededBy === null
          ? "This card has no replacement."
          : `Superseded by ${card.supersededBy}.`;
    },
  };
}
