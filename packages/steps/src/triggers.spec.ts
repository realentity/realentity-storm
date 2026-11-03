import { TRIGGER_EVENTS, type Trigger } from "@ai-me/shared";
import { exampleTriggerData, triggerDataSchema } from "./triggers";

describe("example trigger data for dry runs", () => {
  const triggers: Trigger[] = [
    { on: "run.finished", pipeline: "Job discovery" },
    { on: "application.status", status: ["INTERVIEW"] },
    { on: "recipe.broken", site: "dev.bg" },
    { on: "email.classified", label: ["interview"] },
    { on: "flow.later" },
    { on: "view.action", collection: "releases" },
    { on: "entity.changed", type: "Job", field: "salary" },
    { on: "entity.action", type: "Job" },
    { webhook: "token" },
  ];

  it("has an example for every event, valid against the event's schema", () => {
    expect(triggers.filter((t) => typeof t === "object" && "on" in t).map((t) => (t as { on: string }).on).sort()).toEqual([...TRIGGER_EVENTS].sort());
    for (const trigger of triggers) {
      const schema = triggerDataSchema(trigger)!;
      expect(schema.safeParse(exampleTriggerData(trigger)).error).toBeUndefined();
    }
  });

  it("follows the trigger's own filters, and has none for manual or scheduled pipelines", () => {
    expect(exampleTriggerData({ on: "application.status", status: ["INTERVIEW"] })).toMatchObject({ status: "INTERVIEW", applicationId: "example-application" });
    expect(exampleTriggerData({ on: "email.classified", label: ["interview"] })).toMatchObject({ label: "interview" });
    expect(exampleTriggerData({ on: "run.finished", pipeline: "Job discovery" })).toMatchObject({ pipeline: "Job discovery" });
    expect(exampleTriggerData("manual")).toBeNull();
    expect(exampleTriggerData({ schedule: "0 8 * * *", tz: "Europe/Sofia" })).toBeNull();
  });
});
