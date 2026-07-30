// Display formatting for card fields.

export function formatTimestamp(epochMilliseconds) {
  if (typeof epochMilliseconds !== "number") return "-";
  const date = new Date(epochMilliseconds);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

export function formatQuadrant(card) {
  return `${card.domain} / ${card.visibility}`;
}

export function formatConfidence(confidence) {
  return typeof confidence === "number" ? confidence.toFixed(2) : "-";
}

export function formatCategory(category) {
  return category === null || category === undefined ? "(none)" : category;
}

/**
 * True when the card was retired without a replacement. Retirement is stored as
 * a timestamp (`retiredAt`), so "is it retired" is a presence check.
 */
export function isRetired(card) {
  return card.retiredAt !== null && card.retiredAt !== undefined;
}

/** One-line preview for the list rows. */
export function summarize(text, maxLength = 120) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1)}…`;
}
