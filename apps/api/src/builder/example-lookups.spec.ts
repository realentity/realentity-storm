import { ExampleLookups } from "./example-lookups";

// M70-T3: the builder looks up the example Apps; the eval hides the one a case rebuilds
describe("the examples the builder looks up (M70)", () => {
  it("lists each by id with what it is for, its types and pipelines; reads one whole", () => {
    const examples = new ExampleLookups();
    const list = examples.list();
    expect(list).toMatch(/^bills: Bills: Bills from email, by month, paid or not \(types: Bill; pipelines: bills\)$/m);
    expect(list).toMatch(/^hiring: Hiring: /m);
    expect(list.split("\n").length).toBeGreaterThanOrEqual(20);
    expect(examples.read("bills")).toContain("\npipelines:\n");
    expect(examples.read("no-such")).toBeNull();
  });

  it("hides the ones it is told to", () => {
    const examples = new ExampleLookups(["bills"]);
    expect(examples.list()).not.toMatch(/^bills:/m);
    expect(examples.read("bills")).toBeNull();
    expect(examples.read("tables")).toContain("Tables");
  });
});
