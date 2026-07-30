import { button, el, field, select } from "./dom.js";
import { parseTags } from "./card-edit-form.js";

const NO_CATEGORY = "";

const DOMAIN_OPTIONS = [
  { value: "work", label: "work" },
  { value: "hobby", label: "hobby" },
];

const VISIBILITY_OPTIONS = [
  { value: "sensitive", label: "sensitive" },
  { value: "public", label: "public" },
];

/**
 * Manual card authoring. Doubles as the "retire with a new card" editor: when a
 * supersede target is set, the controller links the target to the created card.
 *
 * `sourceRef` is optional; leaving it blank lets the server mint a `manual:`
 * reference. A reused reference hits the existing de-duplication rule and
 * returns the stored card instead of creating one — the controller reports that
 * outcome rather than claiming a new card was written.
 */
export function createCardCreateForm({ onSubmit }) {
  const heading = el("h3", { textContent: "New card" });
  const targetNote = el("p", { className: "hint" });
  const domain = select(DOMAIN_OPTIONS, "work");
  const visibility = select(VISIBILITY_OPTIONS, "sensitive");
  const category = select([{ value: NO_CATEGORY, label: "(none)" }], NO_CATEGORY);
  const situation = el("textarea", { rows: 3 });
  const judgment = el("textarea", { rows: 3 });
  const rationale = el("textarea", { rows: 3 });
  const tags = el("input", { type: "text", placeholder: "comma separated" });
  const confidence = el("input", { type: "number", min: "0", max: "1", step: "0.05", value: "0.8" });
  const sourceRef = el("input", { type: "text", placeholder: "optional (defaults to manual:<ulid>)" });
  let supersedeTargetId = null;

  function submit() {
    const card = {
      domain: domain.value,
      visibility: visibility.value,
      category: category.value === NO_CATEGORY ? null : category.value,
      situation: situation.value.trim(),
      judgment: judgment.value.trim(),
      rationale: rationale.value.trim(),
      tags: parseTags(tags.value),
      confidence: Number(confidence.value),
    };
    const reference = sourceRef.value.trim();
    if (reference !== "") card.sourceRef = reference;
    onSubmit(card, supersedeTargetId);
  }

  const element = el("section", { className: "panel create-panel" }, [
    heading,
    targetNote,
    el("div", { className: "row" }, [field("Domain", domain), field("Visibility", visibility)]),
    field("Category", category),
    field("Situation", situation),
    field("Judgment", judgment),
    field("Rationale", rationale),
    field("Tags", tags),
    el("div", { className: "row" }, [field("Confidence", confidence), field("sourceRef", sourceRef)]),
    el("div", { className: "row" }, [
      button("Create card", submit, "button primary"),
      button("Clear supersede target", () => setSupersedeTarget(null)),
    ]),
  ]);

  function setSupersedeTarget(card) {
    supersedeTargetId = card === null ? null : card.id;
    heading.textContent = card === null ? "New card" : "Replacement card";
    targetNote.textContent =
      card === null
        ? "Added as a standalone manual card."
        : `On success, card ${card.id} is retired in favour of this one.`;
    if (card === null) return;
    domain.value = card.domain;
    visibility.value = card.visibility;
    category.value = card.category === null ? NO_CATEGORY : card.category;
    situation.value = card.situation;
    judgment.value = card.judgment;
    rationale.value = card.rationale;
    tags.value = card.tags.join(", ");
    confidence.value = String(card.confidence);
    sourceRef.value = "";
  }

  setSupersedeTarget(null);

  return {
    element,
    setSupersedeTarget,
    setCategories(categories) {
      const previous = category.value;
      category.replaceChildren();
      category.append(el("option", { value: NO_CATEGORY, textContent: "(none)" }));
      for (const entry of categories) {
        category.append(el("option", { value: entry.name, textContent: entry.name }));
      }
      category.value = categories.some((entry) => entry.name === previous) ? previous : NO_CATEGORY;
    },
  };
}
