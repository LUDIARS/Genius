import { button, el, field } from "./dom.js";

/**
 * Adds an entry to the controlled category vocabulary. Categories can be added
 * but never deleted (cards keep referencing them), matching the API.
 */
export function createCategoryPanel({ onCreate }) {
  const name = el("input", { type: "text", placeholder: "e.g. gamedev" });
  const description = el("input", { type: "text", placeholder: "what belongs here" });
  const known = el("p", { className: "hint" });

  const element = el("section", { className: "panel category-panel" }, [
    el("h3", { textContent: "Categories" }),
    known,
    field("Name", name),
    field("Description", description),
    el("div", { className: "row" }, [
      button("Add category", () => onCreate(name.value.trim(), description.value.trim())),
    ]),
  ]);

  return {
    element,
    setCategories(categories) {
      known.textContent = `Known: ${categories.map((entry) => entry.name).join(", ")}`;
    },
    reset() {
      name.value = "";
      description.value = "";
    },
  };
}
