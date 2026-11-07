import { AppDefinitionSchema, type JsonSchema, type StepTypeView } from "@ai-me/shared";
import { describe, expect, it } from "vitest";
import { fits, offersFor, type PickerContext } from "./data-picker";
import { loosePipeline } from "./step-cards";

const step = (type: string, input: JsonSchema, output: JsonSchema, more: Partial<StepTypeView> = {}): StepTypeView => ({
  type,
  description: "",
  sideEffect: false,
  headed: false,
  category: type.split(".")[0],
  input,
  output,
  llmOutput: false,
  targets: {},
  credentials: false,
  pageFields: [],
  ...more,
});

const text = { type: "string" };
const CATALOG: StepTypeView[] = [
  step(
    "email.fetch",
    { type: "object", properties: { sinceDays: { type: "integer" } } },
    {
      type: "object",
      properties: {
        messages: { type: "array", items: { type: "object", properties: { from: text, subject: text } } },
        count: { type: "integer" },
      },
    },
  ),
  step(
    "llm.generate",
    { type: "object", properties: { instruction: text } },
    { type: "object", properties: { text, address: text } },
    { llmOutput: true, pageFields: ["address"] },
  ),
  step(
    "data.read",
    { type: "object", properties: { type: text } },
    { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
  ),
  step("notify.telegram", { type: "object", properties: { text } }, { type: "object", properties: {} }),
  step(
    "email.send",
    { type: "object", properties: { to: text, body: text, cc: { type: "array", items: text } } },
    { type: "object", properties: { sent: { type: "boolean" } } },
    { sideEffect: true, targets: { to: "recipient" } },
  ),
];

const APP = AppDefinitionSchema.parse({
  name: "People",
  types: {
    Contact: { key: "email", mine: true, fields: { email: { type: "email", required: true }, age: { type: "number" } } },
    Lead: { key: "email", fields: { email: { type: "email", required: true } } },
  },
});

const context = (source: string): PickerContext => ({
  pipeline: loosePipeline(source)!,
  catalog: CATALOG,
  app: APP,
  triggers: {
    events: {
      "email.classified": { type: "object", properties: { label: text, message: { type: "object", properties: { from: text, text } } } },
      "entity.action": { type: "object", properties: { type: text, item: { type: "object" } } },
    },
    webhook: { type: "object", properties: { body: {}, event: text } },
  },
});

const refs = (ctx: PickerContext, index: number, input: string) => offersFor(ctx, index, input).map((o) => o.reference);

const PIPELINE = `name: P
app: People
trigger: { on: email.classified }
steps:
  - id: fetch
    type: email.fetch
  - id: write
    type: llm.generate
  - id: leads
    type: data.read
    with: { type: Lead }
  - id: send
    type: email.send
    forEach: "{{fetch.messages}}"
  - id: tell
    type: notify.telegram
`;

describe("the data picker (M36-T4)", () => {
  it("takes text, numbers and yes/no into text; a kind into its own", () => {
    expect(fits("text", "number")).toBe(true);
    expect(fits("number", "text")).toBe(false);
    expect(fits("list", "list")).toBe(true);
    expect(fits("list", "object")).toBe(false);
    expect(fits("any", "object")).toBe(true);
  });

  // M36-U2
  it("offers only outputs of a fitting kind, from earlier steps only", () => {
    const ctx = context(PIPELINE);
    const forText = refs(ctx, 4, "text");
    expect(forText).toEqual(
      expect.arrayContaining(["{{trigger.label}}", "{{trigger.message.from}}", "{{fetch.count}}", "{{write.text}}", "{{send.sent}}"]),
    );
    expect(forText).not.toContain("{{fetch.messages}}");
    expect(refs(ctx, 1, "instruction")).not.toContain("{{write.text}}");
    expect(refs(ctx, 0, "sinceDays")).toEqual([]);
    expect(refs(ctx, 3, ":forEach")).toEqual(["{{fetch.messages}}", "{{leads.items}}"]);
    expect(refs(ctx, 3, "cc")).toEqual(["{{fetch.messages}}", "{{leads.items}}"]);
  });

  it("offers a forEach's item and its fields, and an App type's fields for data.read and the entity", () => {
    const ctx = context(PIPELINE);
    expect(refs(ctx, 3, "body")).toEqual(expect.arrayContaining(["{{item.from}}", "{{item.subject}}"]));
    const readEach = context(PIPELINE.replace('forEach: "{{fetch.messages}}"', 'forEach: "{{leads.items}}"'));
    expect(refs(readEach, 3, "body")).toContain("{{item.email}}");
    const action = context(PIPELINE.replace("{ on: email.classified }", "{ on: entity.action, type: Contact }"));
    expect(refs(action, 4, "text")).toEqual(expect.arrayContaining(["{{trigger.item.email}}", "{{trigger.item.age}}"]));
  });

  // M36-S1
  it("never offers for a target what the compiler refuses as one", () => {
    const ctx = context(PIPELINE);
    const to = refs(ctx, 3, "to");
    // An email's own addresses and data are fine; an LLM's text isn't, its page fields are.
    expect(to).toEqual(expect.arrayContaining(["{{trigger.message.from}}", "{{fetch.count}}", "{{item.from}}", "{{write.address}}"]));
    expect(to).not.toContain("{{write.text}}");
    expect(to).not.toContain("{{trigger.label}}");
    // An entity a pipeline wrote isn't; one of a type of mine is.
    const leads = context(PIPELINE.replace('forEach: "{{fetch.messages}}"', 'forEach: "{{leads.items}}"'));
    expect(refs(leads, 3, "to")).not.toContain("{{item.email}}");
    const contacts = context(
      PIPELINE.replace("{ type: Lead }", "{ type: Contact }").replace('forEach: "{{fetch.messages}}"', 'forEach: "{{leads.items}}"'),
    );
    expect(refs(contacts, 3, "to")).toContain("{{item.email}}");
    // A webhook's body never is.
    const hook = context(PIPELINE.replace("{ on: email.classified }", "{ webhook: token }"));
    expect(refs(hook, 3, "to").filter((r) => r.startsWith("{{trigger."))).toEqual([]);
    // Not a target: anything that fits.
    expect(refs(ctx, 3, "body")).toContain("{{write.text}}");
  });
});
