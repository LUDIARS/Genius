import { button, el, field, select } from "./dom.js";

const NO_CATEGORY = "";

/**
 * Edits card content (situation / judgment / rationale / tags / category).
 * Only fields the user actually changed are sent, so an untouched public card
 * is not re-embedded or re-checked for nothing.
 */
export function createCardEditForm({ onSubmit }) {
  const situation = el("textarea", { rows: 4 });
  const judgment = el("textarea", { rows: 4 });
  const rationale = el("textarea", { rows: 4 });
  const tags = el("input", { type: "text", placeholder: "comma separated" });
  const category = select([{ value: NO_CATEGORY, label: "(none)" }], NO_CATEGORY);
  let card = null;

  const element = el("section", { className: "panel edit-panel" }, [
    el("h3", { textContent: "Edit content" }),
    field("Situation", situation),
    field("Judgment", judgment),
    field("Rationale", rationale),
    field("Tags", tags),
    field("Category", category),
    el("div", { className: "row" }, [button("Save content", submit, "button primary")]),
  ]);

  function submit() {
    if (card === null) return;
    const patch = {};
    if (situation.value !== card.situation) patch.situation = situation.value;
    if (judgment.value !== card.judgment) patch.judgment = judgment.value;
    if (rationale.value !== card.rationale) patch.rationale = rationale.value;
    const nextTags = parseTags(tags.value);
    // Compared as JSON, the same way the server decides whether the tags column
    // changed. A joined-string comparison needs a separator that cannot occur in
    // a tag, which is a trap worth not setting.
    if (JSON.stringify(nextTags) !== JSON.stringify(card.tags)) patch.tags = nextTags;
    const nextCategory = category.value === NO_CATEGORY ? null : category.value;
    if (nextCategory !== card.category) patch.category = nextCategory;
    onSubmit(patch);
  }

  return {
    element,
    setCategories(categories) {
      const previous = category.value;
      category.replaceChildren();
      category.append(el("option", { value: NO_CATEGORY, textContent: "(none)" }));
      for (const entry of categories) {
        category.append(el("option", { value: entry.name, textContent: entry.name }));
      }
      category.value = categories.some((entry) => entry.name === previous) ? previous : NO_CATEGORY;
    },
    setCard(next) {
      card = next;
      situation.value = next.situation;
      judgment.value = next.judgment;
      rationale.value = next.rationale;
      tags.value = next.tags.join(", ");
      category.value = next.category === null ? NO_CATEGORY : next.category;
    },
  };
}

export function parseTags(value) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}
