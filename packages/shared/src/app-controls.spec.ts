import { AppDefinitionSchema, filterControlsOf, type AppDefinition } from "./app";
import { listPageOf } from "./app-pages";

// M65-T2: controls, how a field is drawn: a column's read control, a filter's control bound to a source.
const TYPES = {
  Memo: {
    key: "id",
    title: "title",
    mine: true,
    fields: {
      id: { type: "text", auto: true },
      title: { type: "text", required: true },
      tags: { type: "list", of: "text" },
      kind: { type: "enum", values: ["idea", "note"] },
      pinned: { type: "yesno" },
      due: { type: "date" },
    },
  },
};
const SOURCES = {
  tags: { from: "Memo", distinct: "tags" },
  days: { from: "Memo", distinct: "@firstSeen", by: "day" },
  memos: { from: "Memo", sort: "title" },
};

const app = (pages: unknown[]): AppDefinition => AppDefinitionSchema.parse({ name: "Notes", icon: "bookmark", types: TYPES, pages });

const problems = (page: Record<string, unknown>): string[] => {
  const result = AppDefinitionSchema.safeParse({ name: "Notes", icon: "bookmark", types: TYPES, pages: [{ list: "Memo", sources: SOURCES, ...page }] });
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("controls (M65)", () => {
  it("has a default per data type: a date's days by a date input, anything else's values by a dropdown", () => {
    expect(filterControlsOf("date")).toEqual(["date", "calendar"]);
    expect(filterControlsOf("datetime")[0]).toBe("date");
    expect(filterControlsOf("list")).toEqual(["dropdown", "buttons", "chips"]);
    expect(filterControlsOf("enum")[0]).toBe("dropdown");
  });

  it("takes a control of the field's type, on a source that suits it", () => {
    expect(
      problems({
        columns: ["title", { field: "tags", control: "chips" }, { field: "kind", control: "chips" }],
        controls: [
          { control: "buttons", source: "tags", filters: "tags", multiple: true },
          { control: "calendar", source: "days", filters: "@firstSeen" },
          { control: "chips", filters: "kind" },
          { control: "date", filters: "due" },
        ],
      }),
    ).toEqual([]);
    expect(problems({ columns: [{ field: "due", control: "chips" }] })).toEqual([`pages.0.columns.0.control: chips show a list's or an enum's values: "due" is date`]);
    expect(problems({ controls: [{ control: "calendar", filters: "tags" }] })).toEqual([
      "pages.0.controls.0.control: a list field is filtered by dropdown, buttons, chips, not calendar",
    ]);
    expect(problems({ controls: [{ control: "buttons", filters: "due" }] })).toEqual(["pages.0.controls.0.control: a date field is filtered by date, calendar, not buttons"]);
    expect(problems({ controls: [{ control: "buttons", filters: "title" }] })).toEqual([
      'pages.0.controls.0.filters: a filter is an enum, a yes/no, a ref, a list or a date field: "title" is text',
    ]);
    expect(problems({ controls: [{ control: "buttons", filters: "nope" }] })).toEqual(['pages.0.controls.0.filters: Memo has no field "nope"']);
  });

  it("binds a calendar to a source of days, the others to values or items; a field filtered once", () => {
    expect(problems({ controls: [{ control: "calendar", source: "tags", filters: "due" }] })).toEqual([
      "pages.0.controls.0.source: a calendar marks days: its source is { from, distinct: <a date field>, by: day }",
    ]);
    expect(problems({ controls: [{ control: "chips", source: "days", filters: "tags" }] })).toEqual(["pages.0.controls.0.source: a source of days is for a calendar, not chips"]);
    expect(problems({ controls: [{ control: "date", source: "days", filters: "due" }] })).toEqual(["pages.0.controls.0.source: a date input picks any day: it takes no source"]);
    expect(problems({ controls: [{ control: "buttons", source: "nope", filters: "tags" }] })).toEqual([
      'pages.0.controls.0.source: there is no source "nope" on this page (sources: tags, days, memos)',
    ]);
    expect(problems({ controls: [{ control: "calendar", source: "days", filters: "due", multiple: true }] })).toEqual(["pages.0.controls.0.multiple: a calendar picks one day"]);
    expect(problems({ filters: ["kind"], controls: [{ control: "buttons", filters: "kind" }] })).toEqual([
      'pages.0.controls.0.filters: "kind" is filtered already (by filters or an earlier control)',
    ]);
    expect(problems({ controls: [{ control: "buttons", source: "memos", filters: "tags" }] })).toEqual([]);
    // M65-T7: a list of text searched when named, as by default.
    expect(problems({ search: ["title", "tags"] })).toEqual([]);
  });

  it("resolves the filters with their controls: the page's filters (or the defaults) first, then its controls", () => {
    const page = listPageOf(
      app([
        {
          list: "Memo",
          sources: SOURCES,
          columns: ["title", { field: "tags", control: "chips" }],
          controls: [
            { control: "chips", source: "tags", filters: "tags", multiple: true, label: "Tag" },
            { control: "calendar", source: "days", filters: "@firstSeen" },
            { control: "buttons", filters: "kind" },
          ],
        },
      ]),
      "Memo",
    );
    expect(page.columns.map((c) => [c.field, c.control])).toEqual([
      ["title", undefined],
      ["tags", "chips"],
    ]);
    // The default filters (enum and yes/no) without the ones a control draws: pinned, not kind.
    expect(page.filters.map((f) => [f.field, f.label, f.control, f.multiple, f.source, f.match])).toEqual([
      ["pinned", "Pinned", "dropdown", false, null, "equals"],
      ["tags", "Tag", "chips", true, "tags", "contains"],
      ["@firstSeen", "First seen", "calendar", false, "days", "day"],
      ["kind", "Kind", "buttons", false, null, "equals"],
    ]);
    // A list of text matches without case unless it is caseSensitive.
    expect(page.filters.filter((f) => f.caseless).map((f) => f.field)).toEqual(["tags"]);
    const plain = listPageOf(app([{ list: "Memo", filters: ["due", "kind"] }]), "Memo");
    expect(plain.filters.map((f) => [f.field, f.control])).toEqual([
      ["due", "date"],
      ["kind", "dropdown"],
    ]);
  });
});
