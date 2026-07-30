import { button, el, field, select } from "./dom.js";

const ANY = "";

const DOMAIN_OPTIONS = [
  { value: ANY, label: "any domain" },
  { value: "work", label: "work" },
  { value: "hobby", label: "hobby" },
];

const VISIBILITY_OPTIONS = [
  { value: ANY, label: "any visibility" },
  { value: "public", label: "public" },
  { value: "sensitive", label: "sensitive" },
];

const SORT_OPTIONS = [
  { value: "createdAt", label: "created" },
  { value: "confidence", label: "confidence" },
];

const ORDER_OPTIONS = [
  { value: "desc", label: "descending" },
  { value: "asc", label: "ascending" },
];

const LIMIT_OPTIONS = [25, 50, 100, 200].map((size) => ({
  value: String(size),
  label: `${size} / page`,
}));

/**
 * Quadrant / category / tag / full-text filters plus sort and the two
 * inactive-card toggles (superseded and retired are filtered independently, the
 * way the API filters them). Emits the current values through `onApply`; paging
 * is owned by the controller.
 */
export function createFilterPanel({ onApply }) {
  const domain = select(DOMAIN_OPTIONS, ANY);
  const visibility = select(VISIBILITY_OPTIONS, ANY);
  const category = select([{ value: ANY, label: "any category" }], ANY);
  const tag = el("input", { type: "text", placeholder: "tag" });
  const query = el("input", { type: "search", placeholder: "text in situation/judgment/rationale" });
  const sort = select(SORT_OPTIONS, "createdAt");
  const order = select(ORDER_OPTIONS, "desc");
  const limit = select(LIMIT_OPTIONS, "50");
  const includeSuperseded = el("input", { type: "checkbox" });
  const includeRetired = el("input", { type: "checkbox" });

  function read() {
    return {
      domain: domain.value,
      visibility: visibility.value,
      category: category.value,
      tag: tag.value.trim(),
      q: query.value.trim(),
      sort: sort.value,
      order: order.value,
      limit: Number(limit.value),
      includeSuperseded: includeSuperseded.checked ? "true" : "false",
      includeRetired: includeRetired.checked ? "true" : "false",
    };
  }

  const apply = () => onApply(read());

  const toggles = [includeSuperseded, includeRetired];
  for (const control of [domain, visibility, category, sort, order, limit, ...toggles]) {
    control.addEventListener("change", apply);
  }
  for (const control of [tag, query]) {
    control.addEventListener("keydown", (event) => {
      if (event.key === "Enter") apply();
    });
  }

  const element = el("section", { className: "panel filter-panel" }, [
    el("h2", { textContent: "Filters" }),
    el("div", { className: "filter-grid" }, [
      field("Domain", domain),
      field("Visibility", visibility),
      field("Category", category),
      field("Tag", tag),
      field("Text", query),
      field("Sort by", sort),
      field("Order", order),
      field("Page size", limit),
      field("Include superseded", includeSuperseded),
      field("Include retired", includeRetired),
    ]),
    el("div", { className: "row" }, [button("Apply", apply, "button primary")]),
  ]);

  return {
    element,
    read,
    /** Fills the category selector from the controlled vocabulary. */
    setCategories(categories) {
      const previous = category.value;
      category.replaceChildren();
      category.append(el("option", { value: ANY, textContent: "any category" }));
      for (const entry of categories) {
        category.append(el("option", { value: entry.name, textContent: entry.name }));
      }
      category.value = categories.some((entry) => entry.name === previous) ? previous : ANY;
    },
  };
}
