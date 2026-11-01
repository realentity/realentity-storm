import { durationMs, hasOffset, toInstant } from "./time";

describe("times for the calendar and flow.later (M14)", () => {
  it("reads a wall-clock time in its zone, summer and winter", () => {
    expect(toInstant("2026-11-12T10:00", "Europe/Sofia").toISOString()).toBe("2026-11-12T08:00:00.000Z");
    expect(toInstant("2026-07-01T10:00:00", "Europe/Sofia").toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(toInstant("2026-11-12T10:00", "America/New_York").toISOString()).toBe("2026-11-12T15:00:00.000Z");
  });

  it("around a change of offset: the zone's offset after the change", () => {
    // Sofia moves to summer time at 03:00 on 29 March 2026; 04:00 is already +03:00.
    expect(toInstant("2026-03-29T04:00", "Europe/Sofia").toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(toInstant("2026-10-25T12:00", "Europe/Sofia").toISOString()).toBe("2026-10-25T10:00:00.000Z");
  });

  it("keeps a time that names its offset", () => {
    expect(hasOffset("2026-11-12T10:00:00+01:00")).toBe(true);
    expect(hasOffset("2026-11-12T10:00")).toBe(false);
    expect(toInstant("2026-11-12T10:00:00+01:00", "Europe/Sofia").toISOString()).toBe("2026-11-12T09:00:00.000Z");
    expect(toInstant("2026-11-12T10:00:00Z", "Europe/Sofia").toISOString()).toBe("2026-11-12T10:00:00.000Z");
  });

  it("reads delays", () => {
    expect(durationMs("7d")).toBe(7 * 86_400_000);
    expect(durationMs("36h")).toBe(36 * 3_600_000);
    expect(durationMs("30m")).toBe(30 * 60_000);
  });
});
