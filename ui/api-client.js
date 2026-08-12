// Thin wrapper over the Genius REST API. Every write sends
// `Content-Type: application/json` (the service rejects anything else) and
// tags itself as `changedBy: "ui"` so the revision trail records the origin.

const API_BASE = "/api/clone";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path, init = {}) {
  const response = await fetch(path, init);
  const body = await response.text();
  let payload = null;
  if (body !== "") {
    try {
      payload = JSON.parse(body);
    } catch {
      throw new ApiError(`${path} returned a non-JSON response`, response.status);
    }
  }
  if (!response.ok) {
    // Surface the server's own reason verbatim — a rejected public promotion
    // must not be reported as anything other than what the gate said.
    const detail =
      payload !== null && typeof payload.error === "string"
        ? payload.error
        : `HTTP ${response.status}`;
    throw new ApiError(detail, response.status);
  }
  return payload;
}

function writeRequest(path, method, body) {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** `filters` keys map 1:1 onto the documented query parameters. */
export function listCards(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  return request(`${API_BASE}/cards?${params.toString()}`);
}

export function getCard(id) {
  return request(`${API_BASE}/cards/${encodeURIComponent(id)}`);
}

export function getSupersedeChain(id) {
  return request(`${API_BASE}/cards/${encodeURIComponent(id)}/supersede-chain`);
}

export function patchCard(id, patch) {
  return writeRequest(`${API_BASE}/cards/${encodeURIComponent(id)}`, "PATCH", {
    ...patch,
    changedBy: "ui",
  });
}

export function createCard(card) {
  return writeRequest(`${API_BASE}/cards`, "POST", card);
}

export function listCategories() {
  return request(`${API_BASE}/categories`);
}

export function createCategory(name, description) {
  return writeRequest(`${API_BASE}/categories`, "POST", { name, description });
}

export function getStats() {
  return request(`${API_BASE}/stats`);
}

/** @implements SPEC-GENIUS-CARD-FEEDBACK-HTTP */
export function getCardFeedback(id) {
  return request(`${API_BASE}/cards/${encodeURIComponent(id)}/feedback`);
}

/** @implements SPEC-GENIUS-CARD-FEEDBACK-HTTP */
export function sendCardFeedback(id, rating, note) {
  return writeRequest(`${API_BASE}/cards/${encodeURIComponent(id)}/feedback`, "POST", {
    rating,
    source: "ui",
    ...(note ? { note } : {}),
  });
}
/** @implements SPEC-GENIUS-ACTIVE-QUESTION-HTTP */
export function listQuestions(status = "open") {
  const params = new URLSearchParams({ status });
  return request(`${API_BASE}/questions?${params.toString()}`);
}

/**
 * `winnerCardId` is required for contradiction questions and ignored otherwise.
 * @implements SPEC-GENIUS-ACTIVE-QUESTION-HTTP
 */
export function answerQuestion(id, text, winnerCardId) {
  return writeRequest(`${API_BASE}/questions/${encodeURIComponent(id)}/answer`, "POST", {
    text,
    ...(winnerCardId === null || winnerCardId === undefined ? {} : { winnerCardId }),
  });
}

/** @implements SPEC-GENIUS-ACTIVE-QUESTION-HTTP */
export function dismissQuestion(id) {
  return writeRequest(`${API_BASE}/questions/${encodeURIComponent(id)}/dismiss`, "POST", {});
}
