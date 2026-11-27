import { AppDefinitionSchema, type AppDefinition } from "./app";
import { listPageOf } from "./app-pages";
import { dayOf, distinctValues, filterMatches, isDayFilter, sourceItems } from "./app-sources";
import { type ViewRow } from "./view";

// M65-T3/T4: a page's sources and its filters by type.
const app = (pages: unknown[] = []): AppDefinition =>
  AppDefinitionSchema.parse({
    name: "Notes",
    icon: "bookmark",
    types: {
      Memo: {
        key: "id",
        title: "title",
        mine: true,
        fields: {
          id: { type: "text", auto: true },
          title: { type: "text", required: true },
          body: { type: "longtext" },
          tags: { type: "list", of: "text" },
          kind: { type: "enum", values: ["idea", "note", "link"] },
          pinned: { type: "yesno" },
          due: { type: "date" },
          secret: { type: "text", encrypted: true },
        },
      },
    },
    pages,
  });

const problems = (pages: unknown[]): string[] => {
  const result = AppDefinitionSchema.safeParse({ ...structuredClone(app()), pages });
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

const row = (key: string, value: Record<string, unknown>, firstSeenAt = "2026-11-20T10:00:00.000Z"): ViewRow => ({
  key,
  value: { id: key, ...value },
  marks: {},
  firstSeenAt,
  lastSeenAt: firstSeenAt,
  removedAt: null,
});

describe("page sources (M65)", () => {
  it("reads the App's own types, by fields they have, never an encrypted one", () => {
    expect(problems([{ list: "Memo", sources: { tags: { from: "Memo", distinct: "tags" }, days: { from: "Memo", distinct: "@firstSeen", by: "day" } } }])).toEqual([]);
    expect(problems([{ list: "Memo", sources: { bills: { from: "Bill", distinct: "payee" } } }])).toEqual([
      'pages.0.sources.bills.from: there is no type "Bill" in this App (a source reads its own types and its uses)',
    ]);
    expect(problems([{ list: "Memo", sources: { a: { from: "Memo", distinct: "secret" } } }])).toEqual([
      "pages.0.sources.a.distinct: Memo.secret is encrypted: a source can't read it",
    ]);
    expect(problems([{ list: "Memo", sources: { a: { from: "Memo", distinct: "body" } } }])).toEqual([
      'pages.0.sources.a.distinct: a source counts the values of a text, number, enum, yes/no, list, ref or date field: "body" is longtext',
    ]);
    expect(problems([{ list: "Memo", sources: { a: { from: "Memo", distinct: "kind", by: "day" } } }])).toEqual([
      `pages.0.sources.a.by: by day is a date's or a time's: "kind" is enum`,
    ]);
    expect(problems([{ list: "Memo", sources: { a: { from: "Memo", where: [{ field: "nope", op: "eq", value: 1 }], display: "secret" } } }])).toEqual([
      'pages.0.sources.a.where.0.field: Memo has no field "nope"',
      "pages.0.sources.a.display: Memo.secret is encrypted: a source can't read it",
    ]);
  });

  it("filters by a list and a date too; the resolved page says how each matches", () => {
    expect(problems([{ list: "Memo", filters: ["tags", "due", "@firstSeen", "kind"] }])).toEqual([]);
    expect(problems([{ list: "Memo", filters: ["body"] }])).toEqual([
      'pages.0.filters.0: a filter is an enum, a yes/no, a ref, a list or a date field: "body" is longtext',
    ]);
    const page = listPageOf(app([{ list: "Memo", filters: ["tags", "due", "kind", "pinned"], sources: { tags: { from: "Memo", distinct: "tags" } } }]), "Memo");
    expect(page.filters.map((f) => [f.field, f.match, f.values.length])).toEqual([
      ["tags", "contains", 0],
      ["due", "day", 0],
      ["kind", "equals", 3],
      ["pinned", "equals", 2],
    ]);
    expect(page.sources).toEqual({ tags: { from: "Memo", distinct: "tags" } });
  });

  it("counts distinct values: a list's each once per entity, without case; days in the time zone", () => {
    const type = app().types.Memo;
    const rows = [
      row("a", { tags: ["Home", "work"], kind: "note" }, "2026-11-24T22:30:00.000Z"),
      row("b", { tags: ["home", "home"], kind: "idea" }, "2026-11-25T08:00:00.000Z"),
      row("c", { tags: ["Errand"], pinned: true }, "2026-11-25T09:00:00.000Z"),
    ];
    expect(distinctValues(type, "tags", false, rows, "UTC")).toEqual([
      { value: "Home", label: "Home", count: 2 },
      { value: "Errand", label: "Errand", count: 1 },
      { value: "work", label: "work", count: 1 },
    ]);
    // 22:30 UTC on the 24th is the 25th in Sofia.
    expect(distinctValues(type, "@firstSeen", true, rows, "UTC")).toEqual([
      { value: "2026-11-24", label: "2026-11-24", count: 1 },
      { value: "2026-11-25", label: "2026-11-25", count: 2 },
    ]);
    expect(distinctValues(type, "@firstSeen", true, rows, "Europe/Sofia")).toEqual([{ value: "2026-11-25", label: "2026-11-25", count: 3 }]);
    expect(distinctValues(type, "kind", false, rows, "UTC").map((v) => v.value)).toEqual(["idea", "note"]);
    expect(distinctValues(type, "pinned", false, rows, "UTC")).toEqual([{ value: "true", label: "Yes", count: 1 }]);
  });

  it("matches a filter by the field's type: contains, a day or a range, equals; several values: any", () => {
    const type = app().types.Memo;
    const memo = row("a", { tags: ["Home", "work"], kind: "note", due: "2026-11-10" }, "2026-11-24T22:30:00.000Z");
    expect(filterMatches(type, "tags", memo, ["home"], "UTC")).toBe(true);
    expect(filterMatches(type, "tags", memo, ["errand", "WORK"], "UTC")).toBe(true);
    expect(filterMatches(type, "tags", memo, ["hom"], "UTC")).toBe(false);
    expect(filterMatches(type, "due", memo, ["2026-11-10"], "UTC")).toBe(true);
    expect(filterMatches(type, "due", memo, ["2026-11-01..2026-11-30"], "UTC")).toBe(true);
    expect(filterMatches(type, "due", memo, ["..2026-11-09"], "UTC")).toBe(false);
    expect(filterMatches(type, "due", memo, ["2026-11-10.."], "UTC")).toBe(true);
    expect(filterMatches(type, "@firstSeen", memo, ["2026-11-25"], "Europe/Sofia")).toBe(true);
    expect(filterMatches(type, "@firstSeen", memo, ["2026-11-25"], "UTC")).toBe(false);
    expect(filterMatches(type, "kind", memo, ["idea", "note"], "UTC")).toBe(true);
    expect(filterMatches(type, "kind", memo, ["idea"], "UTC")).toBe(false);
    expect(filterMatches(type, "kind", memo, [], "UTC")).toBe(true);
    expect(["2026-11-25", "2026-11-01..2026-11-30", "..2026-11-30", "2026-11-01.."].every(isDayFilter)).toBe(true);
    expect(["", "..", "2026-11", "yesterday", "2026-11-01...2026-11-02"].some(isDayFilter)).toBe(false);
    expect(dayOf("not a date", "datetime", "UTC")).toBeNull();
  });

  it("gives items: the ones that match, in order, by id and label", () => {
    const type = app().types.Memo;
    const rows = [row("a", { title: "Zebra", kind: "idea" }), row("b", { title: "Apple", kind: "idea" }), row("c", { title: "Mango", kind: "note" })];
    const source = { from: "Memo", where: [{ field: "kind", op: "eq" as const, value: "idea" }], sort: "title", limit: 200 };
    expect(sourceItems(type, source, rows, { title: "title" })).toEqual([
      { id: "b", label: "Apple" },
      { id: "a", label: "Zebra" },
    ]);
    expect(sourceItems(type, { from: "Memo", sort: "-title", display: "kind", limit: 1 }, rows, { title: "title" })).toEqual([{ id: "a", label: "idea" }]);
  });
});
