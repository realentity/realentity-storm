const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/** Whether an ISO date-time names its offset (2026-11-12T10:00:00+02:00, …Z) or is a wall-clock time. */
export function hasOffset(text: string): boolean {
  return OFFSET.test(text);
}

/**
 * The instant an ISO 8601 date-time stands for: with an offset as it says, without one as the wall-clock time in
 * `timeZone` (2026-11-12T10:00 in Europe/Sofia is 08:00Z). Daylight saving is read from the zone itself.
 */
export function toInstant(text: string, timeZone: string): Date {
  if (hasOffset(text)) return new Date(text);
  const [date = "", time = ""] = text.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second = "0"] = time.split(":");
  const wall = Date.UTC(year, month - 1, day, Number(hour), Number(minute), Math.floor(Number(second)));
  // The zone's offset at that moment; twice, for a time near a change of offset.
  let guess = wall - offsetOf(wall, timeZone);
  guess = wall - offsetOf(guess, timeZone);
  return new Date(guess);
}

/** How far `timeZone`'s clock is ahead of UTC at an instant, in ms. */
function offsetOf(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(ms / 1000) * 1000;
}

/** "7d", "36h", "30m" in ms. */
export function durationMs(text: string): number {
  const amount = Number(text.slice(0, -1));
  const unit = text.slice(-1);
  return amount * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000);
}
