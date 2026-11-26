import { removeField, removeType, renameField, renameType, setField } from "./app-designer";
import { setPageProperty } from "./app-page-designer";
import { checkAppSource } from "./app-source";

// M65-T6: the designer's edits of a list field's options, a page's sources and its controls.
const SOURCE = `name: Notes
types:
  Memo:
    key: id
    title: title
    mine: true
    fields:
      id: { type: text, auto: true }
      title: { type: text, required: true }
      tags: { type: list, of: text }
      kind: { type: enum, values: [idea, note] }
  Task:
    key: id
    title: title
    mine: true
    fields:
      id: { type: text, auto: true }
      title: { type: text, required: true }
      due: { type: date }
pages:
  - list: Memo
    columns: [title, { field: tags, control: chips }]
    sources:
      tags: { from: Memo, distinct: tags }
      days: { from: Memo, distinct: "@firstSeen", by: day }
      open: { from: Task, where: [{ field: due, op: lt, value: "2026-12-01" }], sort: due, display: title }
    controls:
      - { control: chips, source: tags, filters: tags, multiple: true }
      - { control: calendar, source: days, filters: "@firstSeen" }
      - { control: buttons, filters: kind }
`;

const valid = (source: string) => {
  const { definition, errors } = checkAppSource(source);
  expect(errors).toEqual([]);
  return definition!;
};

describe("the designer's controls (M65-T6)", () => {
  it("sets what a list holds; a list of text's options only when not their defaults", () => {
    valid(SOURCE);
    const notUnique = setField(SOURCE, "Memo", "tags", { unique: false, caseSensitive: true });
    expect(notUnique).toContain("tags: { type: list, of: text, unique: false, caseSensitive: true }");
    expect(setField(notUnique, "Memo", "tags", { unique: true, caseSensitive: false })).toContain("tags: { type: list, of: text }");
    // Another kind, or a list of something else: the options go with it.
    expect(setField(notUnique, "Memo", "tags", { of: undefined })).toContain("tags: { type: list }");
    expect(setField(notUnique, "Memo", "tags", { type: "text" })).toContain("tags: { type: text }");
    const refs = setField(SOURCE, "Memo", "tags", { of: "ref", to: "Task" });
    expect(refs).toContain("tags: { type: list, of: ref, to: Task }");
    expect(setField(refs, "Memo", "tags", { of: "text" })).toContain("tags: { type: list, of: text }");
  });

  it("writes sources and controls a line each", () => {
    const edited = setPageProperty(SOURCE, "list", "Task", "sources", { dueDays: { from: "Task", distinct: "due", by: "day" } });
    const both = setPageProperty(edited, "list", "Task", "controls", [{ control: "calendar", source: "dueDays", filters: "due" }]);
    expect(both).toContain(`  - list: Task
    sources:
      dueDays: { from: Task, distinct: due, by: day }
    controls:
      - { control: calendar, source: dueDays, filters: due }
`);
    valid(both);
  });

  it("renames a field in its controls and in the sources that read its type, on any page", () => {
    const renamed = renameField(renameField(SOURCE, "Memo", "tags", "labels"), "Task", "due", "dueOn");
    expect(renamed).toContain("tags: { from: Memo, distinct: labels }");
    expect(renamed).toContain("- { control: chips, source: tags, filters: labels, multiple: true }");
    expect(renamed).toMatch(/open: \{ from: Task, where: \[\s*\{ field: dueOn, op: lt, value: "2026-12-01" \}\s*\], sort: dueOn, display: title \}/);
    valid(renamed);
  });

  it("removes a field's control and the sources counting it; its other mentions in a source", () => {
    const removed = removeField(SOURCE, "Memo", "tags");
    expect(removed).not.toContain("distinct: tags");
    expect(removed).not.toContain("filters: tags");
    expect(removed).toContain("- { control: calendar, source: days, filters: \"@firstSeen\" }");
    valid(removed);
    const noDue = removeField(SOURCE, "Task", "due");
    expect(noDue).toContain("open: { from: Task, display: title }");
    valid(noDue);
    // A source gone: its control picks from its own values.
    const noKind = removeField(SOURCE, "Memo", "kind");
    expect(noKind).not.toContain("filters: kind");
  });

  it("renames a type in the sources reading it; a type removed takes its sources, the controls keep their own values", () => {
    expect(renameType(SOURCE, "Task", "Todo")).toContain("open: { from: Todo,");
    const removed = removeType(SOURCE, "Task");
    expect(removed).not.toContain("open:");
    valid(removed);
    const daysGone = setPageProperty(SOURCE, "list", "Memo", "sources", { tags: { from: "Memo", distinct: "tags" } });
    // The page now names a source it doesn't have: the check says so.
    expect(checkAppSource(daysGone).errors.map((e) => e.message)).toEqual([expect.stringContaining('there is no source "days"')]);
  });
});
