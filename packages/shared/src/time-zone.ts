/** Whether `zone` is an IANA time zone this runtime knows (e.g. Europe/London). */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The time zone Storm assumes when none is given (schedules, the morning brief, the weekly review): the runtime's own.
 * On the server that is the TZ environment variable (Node follows it; the containers get it from .env), else the
 * host's zone; in the browser, the browser's. UTC when the runtime doesn't know.
 */
export function defaultTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isTimeZone(zone) ? zone : "UTC";
}
