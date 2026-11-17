import { AppDefinitionSchema, listPageOf, viewPageOf } from "@realentity/storm-shared";

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
        "types.Entry.fields.note.to: only a ref points at a type",
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
