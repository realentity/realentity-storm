import { exampleYaml } from "./example-files";
import { appMap, triggerLabel, type AppMapPipeline } from "./app-map";
import { checkAppSource } from "./app-source";
import { type CompiledDefinition } from "./pipeline";

const app = (file: string) => checkAppSource(exampleYaml(`apps/${file}`)).definition!;
const pipeline = (
  pipelineId: string,
  name: string,
  trigger: CompiledDefinition["trigger"],
  steps: [string, Record<string, unknown>?][],
): AppMapPipeline => ({
  pipelineId,
  name,
  enabled: true,
  definition: { trigger, steps: steps.map(([type, w], i) => ({ id: `s${i}`, type, with: w ?? {} })) },
});

// M37-T4: the map of an App: what starts its pipelines, what they write and read, its pages and their buttons
describe("an App's map (M37-T4)", () => {
  it("shows Tables: Table growth on a schedule writing Table, Count now on its list starting it", () => {
    const growth = pipeline("g", "Tables · Growth", { schedule: "0 * * * *", tz: "Europe/Sofia" }, [
      ["db.query"],
      ["data.save", { type: "Table", items: "{{counts.items}}" }],
    ]);
    const map = appMap(app("tables.yaml"), [growth], { Table: 12 }, () => []);
    expect(map.triggers).toEqual([{ id: "trigger:g", label: "on a schedule: 0 * * * *" }]);
    expect(map.types).toEqual([expect.objectContaining({ id: "type:Table", entities: 12, detail: "12 kept" })]);
    expect(map.pages.map((p) => [p.id, p.label])).toEqual([
      ["list:Table", "Tables"],
      ["view:Table", "a Table"],
    ]);
    expect(map.edges).toEqual(
      expect.arrayContaining([
        { from: "trigger:g", to: "pipeline:g", kind: "starts" },
        { from: "pipeline:g", to: "type:Table", kind: "writes" },
        { from: "list:Table", to: "pipeline:g", kind: "starts", label: "Count now" },
        { from: "type:Table", to: "list:Table", kind: "shows" },
      ]),
    );
  });

  it("reads contracts, watches changes and an entity's buttons", () => {
    const bills = app("bills.yaml");
    const save = pipeline("b", "Bills", "manual", [["test.save"]]);
    const remind = pipeline("r", "Remind", { on: "entity.changed", type: "Bill", stage: "due" }, [["data.read", { type: "Bill" }]]);
    const pay = pipeline("p", "Pay", { on: "entity.action", type: "Bill" }, [["notify.telegram"]]);
    const map = appMap(bills, [save, remind, pay], {}, (type) => (type === "test.save" ? [{ type: "Bill" }] : []));
    expect(map.edges).toEqual(
      expect.arrayContaining([
        { from: "pipeline:b", to: "type:Bill", kind: "writes" },
        { from: "type:Bill", to: "pipeline:r", kind: "watches", label: "into due" },
        { from: "type:Bill", to: "pipeline:r", kind: "reads" },
        { from: "view:Bill", to: "pipeline:p", kind: "starts", label: "a button" },
      ]),
    );
    // Drawn as arrows, not as triggers.
    expect(map.triggers.map((t) => t.id)).toEqual(["trigger:b"]);
  });

  // M59-T3: llm.score reads the App's Jobs only with outcomes: true; browser.mapForm moves one only for a job
  it("draws a contract with `when` only when its input is given", () => {
    const jobs = app("job-search.yaml");
    const contracts = (type: string) =>
      type === "llm.score" ? [{ type: "Job", when: "outcomes", reads: true }] : type === "browser.mapForm" ? [{ type: "Job", when: "job" }] : [];
    const calibrated = pipeline("c", "Calibrated", "manual", [["llm.score", { outcomes: true }]]);
    const plain = pipeline("p", "Plain", "manual", [["llm.score", { outcomes: false }], ["llm.score"], ["browser.mapForm", { about: "{{item}}" }]]);
    const apply = pipeline("a", "Apply", "manual", [["browser.mapForm", { job: "{{item}}" }]]);
    const edges = appMap(jobs, [calibrated, plain, apply], {}, contracts).edges;
    expect(edges.filter((e) => e.kind !== "starts" && (e.from.startsWith("pipeline:") || e.to.startsWith("pipeline:")))).toEqual([
      { from: "type:Job", to: "pipeline:c", kind: "reads" },
      { from: "pipeline:a", to: "type:Job", kind: "writes" },
    ]);
  });

  // M66-T4: another App's types it reads, by the App chosen for each, and what reads them
  it("draws each use by where it comes from: the pipelines reading it, the lists with a source of it, a type's ref to it", () => {
    const papers = app("papers.yaml");
    const report = pipeline("r", "Papers · Expense report", "manual", [["data.read", { type: "Bill" }], ["data.read", { type: "Paper" }]]);
    const map = appMap(papers, [report], {}, () => [], { Bill: "Bills › Bill" });
    expect(map.uses).toEqual([{ id: "use:Bill", use: "Bill", label: "Bill", detail: "from Bills › Bill" }]);
    expect(map.edges).toEqual(expect.arrayContaining([{ from: "use:Bill", to: "pipeline:r", kind: "reads" }]));
    expect(appMap(papers, [report], {}, () => []).uses).toEqual([{ id: "use:Bill", use: "Bill", label: "Bill", detail: "not chosen yet" }]);

    const expenses = checkAppSource(`name: Expenses
types:
  Expense:
    key: id
    fields: { id: { type: text }, bill: { type: ref, to: Bill } }
uses:
  Bill: { from: { app: Bills, type: Bill }, fields: [billKey, issuer] }
pages:
  - list: Expense
    sources: { bills: { from: Bill } }
`).definition!;
    expect(appMap(expenses, [], {}, () => []).edges).toEqual(
      expect.arrayContaining([
        { from: "use:Bill", to: "list:Expense", kind: "shows" },
        { from: "use:Bill", to: "type:Expense", kind: "reads", label: "a ref" },
      ]),
    );
    // An App without uses: none.
    expect(appMap(app("tables.yaml"), [], {}, () => []).uses).toEqual([]);
  });

  it("says each trigger plainly", () => {
    expect(triggerLabel("manual")).toBe("by hand");
    expect(triggerLabel({ webhook: "token" })).toBe("a call from the Internet");
    expect(triggerLabel({ on: "run.finished", pipeline: "Fetch" })).toBe("after Fetch");
    expect(triggerLabel({ on: "entity.changed", type: "Bill" })).toBeNull();
  });
});
