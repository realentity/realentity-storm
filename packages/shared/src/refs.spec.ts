import { withCurrentNames, withCurrentRuns } from "./refs";
import { type CompiledDefinition } from "./pipeline";

const names = { apps: { a1: "Library" }, pipelines: { p1: "Books fetched", p2: "Later" } };

// M39-T4: what is shown is the names things have now
describe("the names now (M39-T4)", () => {
  it("shows a definition's App and the pipelines it names under their names now, the rest as saved", () => {
    const definition = {
      name: "After",
      app: "Shelf",
      trigger: { on: "run.finished", pipeline: "Books in" },
      steps: [
        { id: "soon", type: "flow.later", with: { pipeline: "Later", after: "1d" } },
        { id: "note", type: "llm.generate", with: { instruction: "Books in" } },
      ],
      limits: {},
      policy: { allowedDomains: [], allowedRecipients: [] },
      refs: { appId: "a1", pipelines: { "Books in": "p1", Later: "p2" } },
    } as unknown as CompiledDefinition;
    const now = withCurrentNames(definition, names, "After (2)");
    expect(now).toMatchObject({
      name: "After (2)",
      app: "Library",
      trigger: { on: "run.finished", pipeline: "Books fetched" },
      steps: [{ with: { pipeline: "Later" } }, { with: { instruction: "Books in" } }],
      refs: { appId: "a1", pipelines: { "Books fetched": "p1", Later: "p2" } },
    });
    // Saved before M39 (no refs), or a thing since deleted: as it was.
    expect(withCurrentNames({ ...definition, refs: undefined }, names)).toMatchObject({ app: "Shelf", trigger: { pipeline: "Books in" } });
    expect(withCurrentNames(definition, { apps: {}, pipelines: {} })).toMatchObject({ app: "Shelf", trigger: { pipeline: "Books in" } });
  });

  it("shows an App's buttons with their pipelines' names now, its comments kept", () => {
    const source = `name: Shelf
types:
  Book:
    key: isbn
    fields:
      isbn: { type: text, required: true }
pages:
  - list: Book
    actions:
      - { label: Fetch now, run: Books in }   # the hourly one
`;
    expect(withCurrentRuns(source, { pipelines: { "Books in": "p1" } }, names)).toBe(
      source.replace("run: Books in }   #", "run: Books fetched } #"),
    );
    expect(withCurrentRuns(source, null, names)).toBe(source);
  });
});
