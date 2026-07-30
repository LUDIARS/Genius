// Minimal DOM helpers. Everything is built with createElement/textContent so
// card content is never interpolated into HTML.

/**
 * Creates an element. `props` sets properties (className, type, value, ...);
 * `children` accepts nodes and strings, skipping null/undefined.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === "dataset") {
      Object.assign(node.dataset, value);
      continue;
    }
    node[key] = value;
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

/** Labelled control row: `<label>` text above the given control element. */
export function field(labelText, control) {
  return el("label", { className: "field" }, [
    el("span", { className: "field-label", textContent: labelText }),
    control,
  ]);
}

export function select(options, value) {
  const node = el("select", {});
  for (const option of options) {
    node.append(el("option", { value: option.value, textContent: option.label }));
  }
  node.value = value ?? (options[0] === undefined ? "" : options[0].value);
  return node;
}

export function button(labelText, onClick, className = "button") {
  const node = el("button", { className, type: "button", textContent: labelText });
  node.addEventListener("click", onClick);
  return node;
}
