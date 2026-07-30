import { button, el } from "./dom.js";
import { formatTimestamp, isRetired } from "./format.js";

/**
 * Deactivates the selected card without naming a replacement.
 *
 * This is the "the card is simply wrong or obsolete" route; the Supersede panel
 * next to it is the "another card takes over" route. The two are independent
 * server-side (a card can be retired, superseded, or both), so the wording here
 * never mentions replacements. Retiring removes the card from query, vector
 * search, duplicate detection and the public export; reactivating puts it back.
 */
export function createRetireForm({ onRetire, onReactivate }) {
  const state = el("p", { className: "hint" });
  const retireButton = button("Retire (no replacement)", () => onRetire(), "button primary");
  const reactivateButton = button("Un-retire (reactivate)", () => onReactivate());

  const element = el("section", { className: "panel retire-panel" }, [
    el("h3", { textContent: "Retire" }),
    state,
    el("p", { className: "hint", textContent:
      "Retiring hides the card from search, distillation duplicate checks and the "
      + "public export. Nothing is deleted and the text stays editable." }),
    el("div", { className: "row" }, [retireButton, reactivateButton]),
  ]);

  return {
    element,
    setCard(next) {
      const retired = isRetired(next);
      state.textContent = retired
        ? `Retired at ${formatTimestamp(next.retiredAt)}.`
        : "This card is not retired.";
      retireButton.disabled = retired;
      reactivateButton.disabled = !retired;
    },
  };
}
