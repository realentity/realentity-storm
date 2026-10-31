import { isScheduled, nextFireTimes } from "./schedule";

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

// M2-I8 (the time computation; the worker test checks pg-boss gets the schedule with its time zone)
describe("nextFireTimes", () => {
  const weekdays = { schedule: "0 8 * * 1-5", tz: "Europe/Sofia" };

  it("fires at 08:00 Sofia time across the autumn DST change (UTC+3 → UTC+2)", () => {
    // DST ends on Sunday 25 October 2026.
    expect(iso(nextFireTimes(weekdays, new Date("2026-10-22T12:00:00Z"), 3))).toEqual([
      "2026-10-23T05:00:00.000Z",
      "2026-10-26T06:00:00.000Z",
      "2026-10-27T06:00:00.000Z",
    ]);
  });

  it("fires at 08:00 Sofia time across the spring DST change (UTC+2 → UTC+3)", () => {
    // DST starts on Sunday 29 March 2026.
    expect(iso(nextFireTimes(weekdays, new Date("2026-03-26T12:00:00Z"), 3))).toEqual([
      "2026-03-27T06:00:00.000Z",
      "2026-03-30T05:00:00.000Z",
      "2026-03-31T05:00:00.000Z",
    ]);
  });

  it("a local time skipped by DST fires an hour later, a repeated one fires once", () => {
    const nightly = { schedule: "30 3 * * *", tz: "Europe/Sofia" };
    // 29 March: 03:00 → 04:00, so 03:30 doesn't exist; it runs at 04:30 (01:30Z).
    expect(iso(nextFireTimes(nightly, new Date("2026-03-28T00:00:00Z"), 3))).toEqual([
      "2026-03-28T01:30:00.000Z",
      "2026-03-29T01:30:00.000Z",
      "2026-03-30T00:30:00.000Z",
    ]);
    // 25 October: 04:00 → 03:00, so 03:30 happens twice; it runs once.
    expect(iso(nextFireTimes(nightly, new Date("2026-10-24T00:00:00Z"), 3))).toEqual([
      "2026-10-24T00:30:00.000Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
    ]);
  });

  it("uses the trigger's own time zone", () => {
    expect(iso(nextFireTimes({ schedule: "0 8 * * *", tz: "America/New_York" }, new Date("2026-07-01T00:00:00Z"), 1))).toEqual([
      "2026-07-01T12:00:00.000Z",
    ]);
  });

  it("tells manual triggers from schedules", () => {
    expect(isScheduled("manual")).toBe(false);
    expect(isScheduled(weekdays)).toBe(true);
  });
});
