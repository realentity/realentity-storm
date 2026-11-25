import { AppDefinitionSchema, caselessFields, checkEntity, checkFormValues, cleanTextList, fieldValue, withTextLists, type AppDefinition } from "./app";
import { listPageOf } from "./app-pages";
import { matches, matchesAll } from "./conditions";

// M65-T1: a list of text (tags): cleaned on save, matched without case unless caseSensitive.
const memos = (tags: Record<string, unknown> = { type: "list", of: "text" }): AppDefinition =>
  AppDefinitionSchema.parse({
    name: "Memos",
    icon: "bookmark",
    types: {
      Memo: {
        key: "id",
        title: "title",
        mine: true,
        fields: { id: { type: "text", auto: true }, title: { type: "text", required: true }, tags },
      },
    },
  });

describe("list of text (M65)", () => {
  it("is a list's option; unique and caseSensitive only on a list of text", () => {
    expect(memos().types.Memo.fields.tags).toMatchObject({ type: "list", of: "text" });
    expect(memos({ type: "list", of: "text", unique: false, caseSensitive: true }).types.Memo.fields.tags).toMatchObject({ unique: false, caseSensitive: true });
    const wrong = (field: Record<string, unknown>) => {
      const result = AppDefinitionSchema.safeParse({ name: "X", icon: "bookmark", types: { T: { key: "a", fields: { a: { type: "text" }, f: field } } } });
      return result.success ? [] : result.error.issues.map((i) => i.message);
    };
    expect(wrong({ type: "text", unique: true })).toEqual(["only a list of text has unique: type: list, of: text"]);
    expect(wrong({ type: "list", caseSensitive: true })).toEqual(["only a list of text has caseSensitive: type: list, of: text"]);
    expect(wrong({ type: "text", of: "text" })).toEqual(["only a list holds text values: type: list, of: text"]);
    expect(wrong({ type: "list", of: "text", to: "T" })).toEqual(["only a ref (or a list of: ref) points at a type"]);
  });

  it("cleans rather than refuses: trimmed, empty ones dropped, each once with its first spelling", () => {
    const field = memos().types.Memo.fields.tags;
    expect(fieldValue(field, ["  Home ", "", "work", "home", "WORK", "  ", 2026])).toEqual({ ok: true, value: ["Home", "work", "2026"] });
    expect(cleanTextList({ caseSensitive: true }, ["Home", "home", "Home"])).toEqual(["Home", "home"]);
    expect(cleanTextList({ unique: false }, ["a", "a"])).toEqual(["a", "a"]);
    expect(cleanTextList({}, ["x".repeat(300)])).toEqual(["x".repeat(200)]);
    // One value as text: a one-item list (a field that was one value before).
    expect(fieldValue(field, "errand")).toEqual({ ok: true, value: ["errand"] });
    expect(fieldValue(field, [{ a: 1 }])).toEqual({ ok: false, problem: "isn't a list of text" });
    expect(fieldValue(field, 42)).toEqual({ ok: false, problem: "isn't a list of text" });
  });

  it("on a form: one per line, blank lines cleared, a required one refused when left empty", () => {
    const type = memos().types.Memo;
    expect(checkFormValues(type, ["tags"], { tags: "home\n\n Work \nhome\n" })).toEqual({ values: { tags: ["home", "Work"] }, problems: [] });
    expect(checkFormValues(type, ["tags"], { tags: "\n  \n" })).toEqual({ values: { tags: null }, problems: [] });
    const required = memos({ type: "list", of: "text", required: true }).types.Memo;
    expect(checkFormValues(required, ["tags"], { tags: "\n" }).problems).toEqual([{ field: "tags", message: "is required" }]);
  });

  it("a pipeline's item is cleaned the same way", () => {
    const type = memos().types.Memo;
    expect(checkEntity(type, { title: "Buy milk", tags: ["Shop", "shop", " errand "] }).value).toMatchObject({ tags: ["Shop", "errand"] });
  });

  it("an entity saved with one value reads as a one-item list", () => {
    const type = memos().types.Memo;
    expect(withTextLists(type, { title: "a", tags: "home" })).toEqual({ title: "a", tags: ["home"] });
    expect(withTextLists(type, { title: "a", tags: ["x"] })).toEqual({ title: "a", tags: ["x"] });
    expect(withTextLists(type, { title: "a" })).toEqual({ title: "a" });
  });

  it("contains matches a tag without case, unless the list is caseSensitive", () => {
    expect(caselessFields(memos().types.Memo)).toEqual(new Set(["tags"]));
    expect(caselessFields(memos({ type: "list", of: "text", caseSensitive: true }).types.Memo)).toEqual(new Set());
    const item = { tags: ["Home", "work"] };
    const where = [{ field: "tags", op: "contains" as const, value: "home" }];
    expect(matchesAll(item, where, { caseless: new Set(["tags"]) })).toBe(true);
    expect(matchesAll(item, where)).toBe(false);
    // Not a substring of a tag: a whole one.
    expect(matchesAll(item, [{ field: "tags", op: "contains", value: "hom" }], { caseless: new Set(["tags"]) })).toBe(false);
    // Text in text: without case, as before.
    expect(matches("Buy Milk", { op: "contains", value: "milk" })).toBe(true);
  });

  it("a list page searches its lists of text by default", () => {
    expect(listPageOf(memos(), "Memo").search).toEqual(["id", "title", "tags"]);
  });
});
