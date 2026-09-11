import { getStats } from "./api-client.js";
import { button, el } from "./dom.js";

/** Owns explicit, single-flight statistics loading; opening the UI never scans cards. */
export function createStatsPanel({ status }) {
  let requested = false;
  let pending = null;
  const line = el("p", { className: "stats-line", textContent: "Statistics are loaded on request." });
  const refresh = button("Load statistics", () => {
    requested = true;
    void reload();
  });

  function reload() {
    if (pending !== null) return pending;
    refresh.disabled = true;
    refresh.textContent = "Loading statistics…";
    pending = getStats().then((stats) => {
      line.textContent = `${stats.total} cards · active ${stats.active} · superseded ${stats.superseded}`
        + ` · retired ${stats.retired} · `
        + Object.entries(stats.quadrants).map(([quadrant, count]) => `${quadrant} ${count}`).join(" · ");
    }).catch((error) => {
      status.failure("Failed to load stats", error);
    }).finally(() => {
      pending = null;
      refresh.disabled = false;
      refresh.textContent = "Refresh statistics";
    });
    return pending;
  }

  return {
    element: el("div", {}, [line, refresh]),
    refreshIfRequested: () => requested ? reload() : Promise.resolve(),
  };
}
