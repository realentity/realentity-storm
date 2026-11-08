import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitBundle } from "./bundle";
import { checkAppSource } from "./app-source";
import { freeNames, readExamples } from "./examples";

const PIPELINES = join(__dirname, "../../../pipelines");

// M40-T1: the examples are the files in pipelines/, each listed with what it needs
describe("the examples (M40-T1)", () => {
  const examples = readExamples(readFileSync(join(PIPELINES, "examples.yaml"), "utf8"));

  it("lists each example's files, the starter first, each App a valid App", () => {
    expect(examples[0]).toMatchObject({ id: "releases-to-read", starter: true, needs: [] });
    expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length);
    for (const example of examples) {
      const [app] = example.files.map((f) => readFileSync(join(PIPELINES, f), "utf8"));
      expect(checkAppSource(app).errors).toEqual([]);
    }
  });

  it("gives a second install free names, and what refers to them follows", () => {
    const text = `name: Shelf
types:
  Book:
    key: isbn
    fields:
      isbn: { type: text, required: true }
pages:
  - list: Book
    actions:
      - { label: Fetch, run: Books in }   # hourly
---
name: Books in
app: Shelf
steps:
  - id: later
    type: flow.later
    with: { pipeline: Books in, after: 1d }
---
name: After
trigger: { on: run.finished, pipeline: Books in }
steps:
  - id: note
    type: llm.generate
    with: { instruction: "Books in" }
`;
    const documents = splitBundle(text);
    expect(freeNames(documents, { apps: [], pipelines: [] })).toEqual(documents.map((d) => d.source));

    const [app, books, after] = freeNames(documents, { apps: ["Shelf"], pipelines: ["Books in", "Books in (2)"] });
    expect(app).toContain("name: Shelf 2\n");
    expect(app).toContain("run: Books in (3) } # hourly");
    expect(books).toContain("name: Books in (3)\napp: Shelf 2\n");
    expect(books).toContain("pipeline: Books in (3)");
    expect(after).toContain("name: After\n");
    expect(after).toContain("pipeline: Books in (3) }");
    // Text that only says the name is left as it is.
    expect(after).toContain('instruction: "Books in"');
  });
});
