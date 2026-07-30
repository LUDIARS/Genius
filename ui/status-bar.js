import { el } from "./dom.js";

/**
 * Single place where outcomes are reported. Failures are always shown with the
 * server's own message — no silent swallowing, no "saved" message for a call
 * that was rejected.
 */
export function createStatusBar() {
  const element = el("div", { className: "status-bar", role: "status" });

  function show(message, kind) {
    element.className = `status-bar status-${kind}`;
    element.textContent = message;
  }

  return {
    element,
    info(message) {
      show(message, "info");
    },
    error(message) {
      show(message, "error");
    },
    /** Reports a rejected call, including its HTTP status when available. */
    failure(context, error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status = typeof error?.status === "number" ? ` (HTTP ${error.status})` : "";
      show(`${context}: ${detail}${status}`, "error");
    },
  };
}
