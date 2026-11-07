import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appMap, triggerLabel, type AppMapPipeline } from "./app-map";
import { checkAppSource } from "./app-source";
import { type CompiledDefinition } from "./pipeline";

const app = (file: string) => checkAppSource(readFileSync(join(__dirname, `../../../pipelines/apps/${file}`), "utf8")).definition!;
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
    const growth = pipeline("g", "Table growth", { schedule: "0 * * * *", tz: "Europe/Sofia" }, [
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
    const save = pipeline("b", "Bills", "manual", [["bill.save"]]);
    const remind = pipeline("r", "Remind", { on: "entity.changed", type: "Bill", stage: "due" }, [["data.read", { type: "Bill" }]]);
    const pay = pipeline("p", "Pay", { on: "entity.action", type: "Bill" }, [["notify.telegram"]]);
    const map = appMap(bills, [save, remind, pay], {}, (type) => (type === "bill.save" ? [{ type: "Bill" }] : []));
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

  it("says each trigger plainly", () => {
    expect(triggerLabel("manual")).toBe("by hand");
    expect(triggerLabel({ webhook: "token" })).toBe("a call from the Internet");
    expect(triggerLabel({ on: "run.finished", pipeline: "Fetch" })).toBe("after Fetch");
    expect(triggerLabel({ on: "entity.changed", type: "Bill" })).toBeNull();
  });
});
