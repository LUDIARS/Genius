// C-3 followupDueWindow(now, delayDays, windowDays): decisions from
// delay + window days ago up to delay days ago are due.

const DAY = 24 * 60 * 60 * 1_000;

type Window = { readonly decidedFrom: number; readonly decidedTo: number };

export default {
  post: (result: Window, now: number, delayDays: number, windowDays: number): true | string => {
    if (result.decidedTo !== now - delayDays * DAY) return "decidedTo must be delay days before now";
    return result.decidedFrom === result.decidedTo - windowDays * DAY
      || "decidedFrom must be window days before decidedTo";
  },
};
