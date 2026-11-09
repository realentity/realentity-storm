/**
 * The time zone every test runs in: the server's (the default for schedules, the morning brief, …) and, in the
 * browser tests, the browser's (a new schedule's default tz). The expectations are written in it, so the results are
 * the same on every machine and in CI, whatever its own zone.
 */
export const TEST_TIME_ZONE = "Europe/Sofia";
