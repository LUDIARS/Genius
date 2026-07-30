import { button, el, field, select } from "./dom.js";

const DOMAIN_OPTIONS = [
  { value: "work", label: "work" },
  { value: "hobby", label: "hobby" },
];

const VISIBILITY_OPTIONS = [
  { value: "public", label: "public" },
  { value: "sensitive", label: "sensitive" },
];

/**
 * Quadrant (domain / visibility) correction.
 *
 * A sensitive→public promotion is re-checked server-side and may be refused
 * with 409; the refusal is reported by the shared status bar with the server's
 * own wording, and the card stays as it was. This form never presents a
 * rejected promotion as applied (spec/feature/operations.md Sections 2 and 5).
 */
export function createQuadrantForm({ onSubmit }) {
  const domain = select(DOMAIN_OPTIONS, "work");
  const visibility = select(VISIBILITY_OPTIONS, "sensitive");
  let card = null;

  function submit() {
    if (card === null) return;
    const patch = {};
    if (domain.value !== card.domain) patch.domain = domain.value;
    if (visibility.value !== card.visibility) patch.visibility = visibility.value;
    onSubmit(patch);
  }

  const element = el("section", { className: "panel quadrant-panel" }, [
    el("h3", { textContent: "Quadrant" }),
    el("p", { className: "hint", textContent:
      "Promoting sensitive → public re-runs the sensitive check on the server. "
      + "If it refuses, the card is left unchanged and the reason is shown above." }),
    el("div", { className: "row" }, [field("Domain", domain), field("Visibility", visibility)]),
    el("div", { className: "row" }, [button("Apply quadrant", submit, "button primary")]),
  ]);

  return {
    element,
    setCard(next) {
      card = next;
      domain.value = next.domain;
      visibility.value = next.visibility;
    },
  };
}
