import { defaultCatalog } from "@ai-me/steps";
import { MapStep } from "./map-alert-steps";

const FORECAST = { hourly: { time: ["2026-11-03T14:00", "2026-11-03T15:00", "2026-11-03T16:00"], temperature_2m: [12.1, 9.4, 9.8] } };

const map = (from: unknown, expression: string, maxItems?: number) =>
  new MapStep().execute(defaultCatalog().get("data.map")!.input.parse({ from, expression, maxItems })) as Promise<{ items: unknown[]; value: unknown }>;

// M29-U2
describe("data.map", () => {
  it("parallel arrays into one item each; one summary object into one item", async () => {
    expect((await map(FORECAST, '$map(hourly.time, function($t, $i) { { "time": $t, "temp": hourly.temperature_2m[$i] } })')).items).toEqual([
      { time: "2026-11-03T14:00", temp: 12.1 },
      { time: "2026-11-03T15:00", temp: 9.4 },
      { time: "2026-11-03T16:00", temp: 9.8 },
    ]);
    const lowest = await map(
      FORECAST,
      `(
        $t := hourly.temperature_2m;
        $low := $min($t);
        $at := $map($t, function($v, $i) { $v = $low ? $i })[0];
        { "place": "Sofia", "min": $low, "at": $substringAfter(hourly.time[$at], "T") }
      )`,
    );
    expect(lowest).toEqual({ items: [{ place: "Sofia", min: 9.4, at: "15:00" }], value: { place: "Sofia", min: 9.4, at: "15:00" } });
  });

  it("anything else as { value }; nothing matched, no items; at most maxItems", async () => {
    expect((await map(FORECAST, "hourly.temperature_2m")).items).toEqual([{ value: 12.1 }, { value: 9.4 }, { value: 9.8 }]);
    expect(await map(FORECAST, "daily.sunrise")).toEqual({ items: [], value: null });
    expect((await map(FORECAST, "hourly.time", 2)).items).toHaveLength(2);
  });

  it("stops an expression that doesn't end, and says what is wrong with one that fails", async () => {
    await expect(map({}, "($f := function($n) { $f($n + 1) }; $f(0))")).rejects.toThrow(/^data\.map: .*(timeout|stack)/i);
    await expect(map(FORECAST, '$number("x")')).rejects.toThrow(/^data\.map: /);
  });
});
