import { AppDefinitionSchema, reportOf, reportPageOf, type ReportEntity } from "@realentity/storm-shared";

const types = {
  Job: {
    key: "url",
    stages: {
      field: "status",
      initial: "new",
      states: ["new", "applied", "interview", "rejected"],
      moves: [
        { from: "new", to: ["applied"] },
        { from: "applied", to: ["interview", "rejected"] },
        { from: "interview", to: ["rejected"] },
      ],
    },
    fields: {
      url: { type: "text", required: true },
      score: { type: "number" },
      source: { type: "text" },
      fee: { type: "money", currency: "cur" },
      cur: { type: "text" },
      note: { type: "longtext" },
      posted: { type: "date" },
    },
  },
  Note: { key: "id", fields: { id: { type: "text", required: true }, size: { type: "number" } } },
};

const REPORT = {
  report: "Job",
  periods: [30, 90],
  tiles: [
    { label: "Found", count: true },
    { label: "Applied", reached: "applied" },
    { label: "Interviews", reached: ["interview"], of: "Applied" },
    { label: "Fees", sum: "fee" },
    { label: "Board fees", sum: "fee", when: { source: "board" } },
  ],
  trends: [{ label: "Found", count: true, every: "week" }],
  tables: [
    { by: "score", bands: [80, 50], columns: ["Found", "Applied", "Interviews"] },
    { by: "source", columns: ["Found", "Interviews"] },
  ],
};

const app = (pages: unknown[] = [REPORT]) => AppDefinitionSchema.parse({ name: "Jobs", types, pages });
const issues = (report: Record<string, unknown>) => {
  const result = AppDefinitionSchema.safeParse({ name: "Jobs", types, pages: [{ ...REPORT, ...report }] });
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

const NOW = new Date("2026-11-18T12:00:00Z");
function job(key: string, seen: string, value: Record<string, unknown>, stage: string, dates: string[] = []): ReportEntity {
  return {
    row: { key, value: { url: key, ...value, status: stage }, marks: {}, firstSeenAt: seen, lastSeenAt: seen, removedAt: null },
    stageDates: Object.fromEntries(dates.map((d) => [d, seen])),
  };
}
const JOBS = [
  job("a", "2026-11-17T09:00:00Z", { score: 90, source: "board", fee: 10, cur: "EUR" }, "interview", ["applied", "interview"]),
  job("b", "2026-11-10T09:00:00Z", { score: 85, source: "board" }, "rejected", ["applied", "rejected"]),
  job("c", "2026-11-03T09:00:00Z", { score: 60, source: "site", fee: 5, cur: "BGN" }, "new"),
  // Applied now, without a date kept for it: its current stage counts.
  job("d", "2026-11-16T09:00:00Z", { source: "site" }, "applied"),
  job("old", "2026-08-01T09:00:00Z", { score: 95, source: "board" }, "interview", ["applied", "interview"]),
];

describe("an App's report page", () => {
  it("is resolved from what is written, labelled and iconed by default", () => {
    const page = reportPageOf(app(), "Job")!;
    expect(page).toMatchObject({ type: "Job", label: "Job report", icon: "chart", date: { field: "@firstSeen", label: "First seen" }, periods: [30, 90], stage: "status" });
    expect(page.tiles[3]).toMatchObject({ sum: "fee", currency: "cur", reached: null });
    expect(page.tiles[1].reached).toEqual(["applied"]);
    expect(page.tables.map((t) => [t.label, t.bands])).toEqual([
      ["By score", [80, 50]],
      ["By source", null],
    ]);
    expect(reportPageOf(app(), "Note")).toBeNull();
  });

  it("counts, sums and states reached in the period, with shares", () => {
    const report = reportOf(reportPageOf(app(), "Job")!, JOBS, 30, NOW);
    expect(report.count).toBe(4);
    expect(report.from).toBe("2026-10-19T12:00:00.000Z");
    expect(report.tiles).toEqual([
      { label: "Found", sums: { "": 4 }, share: null },
      { label: "Applied", sums: { "": 3 }, share: null },
      { label: "Interviews", sums: { "": 1 }, share: 33 },
      { label: "Fees", sums: { EUR: 10, BGN: 5 }, share: null },
      { label: "Board fees", sums: { EUR: 10 }, share: null },
    ]);
    expect(reportOf(reportPageOf(app(), "Job")!, JOBS, null, NOW)).toMatchObject({ from: null, count: 5 });
  });

  it("draws a trend a point per week of the period, the empty ones zero", () => {
    const [trend] = reportOf(reportPageOf(app(), "Job")!, JOBS, 30, NOW).trends;
    expect(trend.series).toEqual([
      {
        currency: "",
        points: [
          { at: "2026-10-19T00:00:00.000Z", value: 0 },
          { at: "2026-10-26T00:00:00.000Z", value: 0 },
          { at: "2026-11-02T00:00:00.000Z", value: 1 },
          { at: "2026-11-09T00:00:00.000Z", value: 1 },
          { at: "2026-11-16T00:00:00.000Z", value: 2 },
        ],
      },
    ]);
  });

  it("puts the tiles in tables: bands in order, values the most first, the ones without a value last", () => {
    const [bands, sources] = reportOf(reportPageOf(app(), "Job")!, JOBS, 30, NOW).tables;
    expect(bands.rows.map((r) => [r.label, ...r.cells.map((c) => [c.sums[""], c.share])])).toEqual([
      ["80+", [2, null], [2, null], [1, 50]],
      ["50–80", [1, null], [0, null], [0, null]],
      ["—", [1, null], [1, null], [0, 0]],
    ]);
    expect(sources.rows.map((r) => [r.label, r.cells[0].sums[""], r.cells[1].share])).toEqual([
      ["board", 2, 50],
      ["site", 2, 0],
    ]);
    expect(sources.more).toBe(0);
  });

  it("puts an entity in the period by the date field the page names", () => {
    const page = reportPageOf(app([{ ...REPORT, date: "posted" }]), "Job")!;
    const posted = [job("p", "2026-01-01T00:00:00Z", { posted: "2026-11-01" }, "new"), job("q", "2026-11-17T00:00:00Z", {}, "new")];
    expect(reportOf(page, posted, 30, NOW).count).toBe(1);
    expect(reportOf(page, posted, null, NOW).count).toBe(2);
  });

  it("refuses measures, shares and columns that don't fit the type", () => {
    expect(issues({})).toEqual([]);
    expect(issues({ tiles: [{ label: "Nothing" }], tables: [] })).toEqual(["pages.0.tiles.0: one of count: true, sum: <field> or reached: <state>"]);
    expect(issues({ tiles: [{ label: "Both", count: true, sum: "score" }], tables: [], trends: [] })).toEqual([
      "pages.0.tiles.0: one of count: true, sum: <field> or reached: <state>",
    ]);
    expect(issues({ tiles: [{ label: "Notes", sum: "note" }], tables: [] })).toEqual(['pages.0.tiles.0.sum: a sum is of a number or money field: "note" is longtext']);
    expect(issues({ tiles: [{ label: "Offers", reached: ["applied", "offer"] }], tables: [] })).toEqual([`pages.0.tiles.0.reached: "offer" is not one of Job's states`]);
    expect(issues({ tiles: [{ label: "Found", count: true, of: "Found" }], tables: [] })).toEqual(['pages.0.tiles.0.of: "Found" is not another tile (tiles: Found)']);
    expect(issues({ tiles: [{ label: "Found", count: true }, { label: "Fees", sum: "fee", of: "Found" }], tables: [] })).toEqual([
      "pages.0.tiles.1.of: a share is of counts or number sums, not money",
    ]);
    expect(issues({ tiles: [{ label: "Found", count: true }, { label: "Found", count: true }], tables: [] })).toEqual(['pages.0.tiles.1.label: "Found" is used by an earlier tile']);
    expect(issues({ tables: [{ by: "source", bands: [10], columns: ["Found", "Offers"] }] })).toEqual([
      'pages.0.tables.0.bands: bands are of a number or money field: "source" is text',
      'pages.0.tables.0.columns.1: "Offers" is not a tile (tiles: Found, Applied, Interviews, Fees, Board fees)',
    ]);
    expect(issues({ date: "source" })).toEqual(['pages.0.date: a report\'s date is a date field: "source" is text']);
    expect(issues({ tiles: [{ label: "Found", count: true, when: { colour: "red" } }], tables: [] })).toEqual(['pages.0.tiles.0.when.colour: Job has no field "colour"']);
    const noStages = AppDefinitionSchema.safeParse({ name: "Jobs", types, pages: [{ report: "Note", tiles: [{ label: "Done", reached: "done" }] }] });
    expect(noStages.success ? [] : noStages.error.issues.map((i) => i.message)).toEqual(["Note has no stages"]);
    const twice = AppDefinitionSchema.safeParse({ name: "Jobs", types, pages: [REPORT, REPORT] });
    expect(twice.success ? [] : twice.error.issues.map((i) => i.message)).toEqual(["Job already has a report page"]);
  });
});
