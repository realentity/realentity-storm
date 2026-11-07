import { describe, expect, it } from "vitest";
import { readCron, writeCron } from "./cron";

describe("a schedule as days and times (M36-T2)", () => {
  it("reads the crons that are days and times", () => {
    expect(readCron("0 8,18 * * *")).toEqual({ times: ["08:00", "18:00"], days: [0, 1, 2, 3, 4, 5, 6] });
    expect(readCron("30 9 * * 1-5")).toEqual({ times: ["09:30"], days: [1, 2, 3, 4, 5] });
    expect(readCron("0 7 * * 0,6")).toEqual({ times: ["07:00"], days: [0, 6] });
    expect(readCron("0 7 * * 7")).toEqual({ times: ["07:00"], days: [0] });
  });

  it("leaves the others alone", () => {
    expect(readCron("*/15 * * * *")).toBeNull();
    expect(readCron("0 * * * *")).toBeNull();
    expect(readCron("0 8 1 * *")).toBeNull();
    expect(readCron("0 8 * *")).toBeNull();
  });

  it("writes them back as I would", () => {
    expect(writeCron({ times: ["08:00", "18:00"], days: [0, 1, 2, 3, 4, 5, 6] })).toBe("0 8,18 * * *");
    expect(writeCron({ times: ["09:30"], days: [5, 1, 2, 3, 4] })).toBe("30 9 * * 1-5");
    expect(writeCron({ times: ["07:00"], days: [0, 6] })).toBe("0 7 * * 0,6");
    expect(writeCron({ times: ["07:00"], days: [1, 3, 5] })).toBe("0 7 * * 1,3,5");
    for (const cron of ["0 8,18 * * *", "30 9 * * 1-5", "0 7 * * 0,6"]) expect(writeCron(readCron(cron)!)).toBe(cron);
  });
});
