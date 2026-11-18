const KEY = "storm.failuresSeenAt";
const DAY_MS = 24 * 60 * 60 * 1000;

/** When this browser last showed History; never (or no storage): the last day's failures are new. */
export function failuresSeenAt(now = Date.now()): string {
  try {
    const seen = localStorage.getItem(KEY);
    if (seen && !Number.isNaN(Date.parse(seen))) return seen;
  } catch {
    // Storage blocked: the default below.
  }
  return new Date(now - DAY_MS).toISOString();
}

export function markFailuresSeen(now = Date.now()): void {
  try {
    localStorage.setItem(KEY, new Date(now).toISOString());
  } catch {
    // Storage blocked: the count just isn't remembered.
  }
}
