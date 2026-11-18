import {
  AppDefinitionSchema,
  checkEntity,
  fieldApplies,
  fieldValue,
  listPageOf,
  readAppSource,
  viewPageOf,
} from "@realentity/storm-shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = (types: object, pages: object[] = []) => ({ name: "Lockbox", types, pages });
const issues = (definition: object) => {
  const result = AppDefinitionSchema.safeParse(definition);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

const PROJECT = { mine: true, key: "name", fields: { name: { type: "text", required: true } } };
const ENTRY = {
  mine: true,
  key: "id",
  title: "name",
  fields: {
    id: { type: "text", auto: true },
    name: { type: "text", required: true, help: "As GitHub will have it" },
    project: { type: "ref", to: "Project", required: true },
    kind: { type: "enum", values: ["variable", "secret"] },
  },
};

// M55-U1: references between an App's types, related lists, field help
describe("references (M55)", () => {
  it("takes a ref to a type of the App, filtered by, listed on that type's page", () => {
    const definition = AppDefinitionSchema.parse(
      app({ Project: PROJECT, Entry: ENTRY }, [
        { list: "Entry", filters: ["project", "kind"] },
        { view: "Project", related: [{ type: "Entry", by: "project", columns: ["name", "kind"], filters: ["kind"], add: true }] },
      ]),
    );
    expect(listPageOf(definition, "Entry").filters.map((f) => [f.field, f.ref ?? null])).toEqual([
      ["project", "Project"],
      ["kind", null],
    ]);
    const [related] = viewPageOf(definition, "Project").related;
    expect(related).toMatchObject({
      type: "Entry",
      by: "project",
      title: "name",
      create: expect.arrayContaining([expect.objectContaining({ field: "project", ref: "Project" })]) as unknown,
    });
    expect(related.create!.find((f) => f.field === "name")?.help).toBe("As GitHub will have it");
  });

  it("refuses a ref without its type, to a type that isn't there, and `to` on another kind", () => {
    expect(
      issues(
        app({
          Project: PROJECT,
          Entry: {
            ...ENTRY,
            fields: {
              ...ENTRY.fields,
              project: { type: "ref" },
              other: { type: "ref", to: "Nope" },
              note: { type: "text", to: "Project" },
            },
          },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "types.Entry.fields.project.to: a ref says which type it points at: to: Project",
        "types.Entry.fields.note.to: only a ref (or a list of: ref) points at a type",
        'types.Entry.fields.other.to: there is no type "Nope" (types: Project, Entry)',
      ]),
    );
  });

  it("refuses a related list by a field that isn't a ref to the page's type, or added where it can't be", () => {
    expect(
      issues(
        app(
          { Project: PROJECT, Entry: ENTRY, Log: { key: "id", fields: { id: { type: "text" }, project: { type: "ref", to: "Project" } } } },
          [
            {
              view: "Project",
              related: [
                { type: "Entry", by: "kind" },
                { type: "Nope", by: "project" },
                { type: "Log", by: "project", add: true },
              ],
            },
          ],
        ),
      ),
    ).toEqual([
      "pages.0.related.0.by: Entry.kind isn't a ref to Project",
      'pages.0.related.1.type: there is no type "Nope"',
      "pages.0.related.2.add: Log isn't added by hand (a type of mine, or add: true on its list)",
    ]);
  });
});

const PATH = {
  mine: true,
  key: "id",
  title: "name",
  fields: {
    id: { type: "text", auto: true },
    project: { type: "ref", to: "Project", required: true },
    name: { type: "text", required: true },
  },
};
const ENTRY2 = {
  ...ENTRY,
  fields: {
    ...ENTRY.fields,
    path: { type: "ref", to: "Path", match: "project", required: true },
    value: { type: "longtext", when: { kind: "variable" } },
    secret: { type: "longtext", encrypted: true, required: true, when: { kind: "secret" } },
  },
};
const BUNDLE = {
  mine: true,
  key: "name",
  fields: {
    name: { type: "text", required: true },
    project: { type: "ref", to: "Project", required: true },
    paths: { type: "list", of: "ref", to: "Path", match: "project", required: true },
  },
};

// M56-U1: a ref matching another field, a list of refs, a field shown by others, Add presets, groups
describe("matching refs, lists of refs, when, Add presets and groups (M56)", () => {
  it("resolves them for the form and the related list", () => {
    const definition = AppDefinitionSchema.parse(
      app({ Project: PROJECT, Path: PATH, Entry: ENTRY2, Bundle: BUNDLE }, [
        {
          view: "Project",
          related: [
            {
              type: "Entry",
              by: "project",
              group: "path",
              filters: ["kind"],
              add: [
                { label: "Add variable", set: { kind: "variable" } },
                { label: "Add secret", set: { kind: "secret" } },
              ],
            },
            { type: "Bundle", by: "project", add: true },
          ],
        },
      ]),
    );
    const [entries, bundles] = viewPageOf(definition, "Project").related;
    expect(entries.adds).toEqual([
      { label: "Add variable", set: { kind: "variable" } },
      { label: "Add secret", set: { kind: "secret" } },
    ]);
    expect(entries.group).toEqual({ field: "path", label: "Path", values: null, ref: "Path", match: "project" });
    const fields = Object.fromEntries(entries.create!.map((f) => [f.field, f]));
    expect(fields.path).toMatchObject({ ref: "Path", match: "project" });
    expect(fields.secret).toMatchObject({ when: { kind: "secret" }, encrypted: true });
    expect(bundles.adds).toEqual([{ label: "Add", set: {} }]);
    expect(bundles.create!.find((f) => f.field === "paths")).toMatchObject({ kind: "list", ref: "Path", match: "project" });
  });

  it("shows a field while the others are as its when says, and requires it only then", () => {
    const definition = AppDefinitionSchema.parse(app({ Project: PROJECT, Path: PATH, Entry: ENTRY2 }));
    const secret = definition.types.Entry.fields.secret;
    expect(fieldApplies(secret, { kind: "secret" })).toBe(true);
    expect(fieldApplies(secret, { kind: "variable" })).toBe(false);
    expect(fieldApplies(definition.types.Entry.fields.name, {})).toBe(true);
    const variable = checkEntity(definition.types.Entry, { id: "a", name: "LOG", kind: "variable", project: "Acme", path: "p1" });
    expect(variable.rejected).toBe(false);
    expect(checkEntity(definition.types.Entry, { id: "a", name: "DB", kind: "secret", project: "Acme", path: "p1" }).problems).toContain(
      "secret is missing",
    );
  });

  it("keeps a list of refs as keys, each once, in order", () => {
    expect(fieldValue({ type: "list", of: "ref", to: "Path", required: false, mine: false }, ["b", "a", "b", " c "])).toEqual({
      ok: true,
      value: ["b", "a", "c"],
    });
    expect(fieldValue({ type: "list", of: "ref", to: "Path", required: false, mine: false }, ["a", ""]).ok).toBe(false);
  });

  it("refuses a match, an of, a when and a related list's add or group that can't be", () => {
    expect(
      issues(
        app(
          {
            Project: PROJECT,
            Other: { key: "id", fields: { id: { type: "text" } } },
            Path: { ...PATH, fields: { ...PATH.fields, project: { type: "ref", to: "Other" } } },
            Entry: {
              ...ENTRY2,
              fields: {
                ...ENTRY2.fields,
                note: { type: "text", match: "project" },
                tags: { type: "text", of: "ref" },
                self: { type: "ref", to: "Path", match: "self" },
                byText: { type: "ref", to: "Path", match: "name" },
                shown: { type: "text", when: { name: "x" } },
                odd: { type: "text", when: { kind: "maybe" } },
              },
            },
          },
          [
            {
              view: "Project",
              related: [{ type: "Entry", by: "project", group: "name", add: [{ label: "Add", set: { kind: "maybe", project: "x" } }] }],
            },
          ],
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "types.Entry.fields.note.match: only a ref picks among the ones that match",
        "types.Entry.fields.tags.of: only a list holds refs: type: list, of: ref",
        "types.Entry.fields.self.match: a ref matches another field of its type",
        'types.Entry.fields.byText.match: "name" isn\'t a ref field of this type',
        'types.Entry.fields.shown.when.name: a field shows by an enum or a yes/no field: "name" is text',
        "types.Entry.fields.odd.when.kind: \"maybe\" isn't one of kind's values (variable, secret)",
        "types.Entry.fields.path.match: Path.project isn't a ref to Project as Entry.project is",
        "pages.0.related.0.add.0.set.kind: Entry.kind isn't one of variable, secret",
        "pages.0.related.0.add.0.set.project: project is set to this Project already",
        'pages.0.related.0.group: a related list groups by an enum or a ref field: "name" is text',
      ]),
    );
  });

  it("is what Lockbox is built with", () => {
    const lockbox = readAppSource(readFileSync(join(__dirname, "../../../pipelines/apps/lockbox.yaml"), "utf8"));
    const entries = viewPageOf(lockbox, "Project").related.find((r) => r.type === "Entry")!;
    expect(entries.group?.ref).toBe("Path");
    expect(entries.adds.map((a) => a.label)).toEqual(["Add variable", "Add secret"]);
    const bundle = lockbox.types.Bundle.fields;
    expect(fieldApplies(bundle.organization, { destination: "organization" })).toBe(true);
    expect(fieldApplies(bundle.repository, { destination: "organization" })).toBe(false);
  });
});
