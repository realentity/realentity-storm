import { describe, expect, it } from "vitest";
import { appMarks, pipelineMarks } from "./builder-marks";

// M38-T5: a proposal used in an editor: what it changes, marked where it is
describe("the builder's marks (M38-T5)", () => {
  it("marks a pipeline's changed and added steps and its trigger", () => {
    const before = `name: P
trigger: manual
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: tell
    type: notify.telegram
    with: { text: hi }
`;
    const after = before
      .replace("trigger: manual", 'trigger: { schedule: "0 8 * * *" }')
      .replace("query: dotnet", "query: dotnet Plovdiv")
      .replace(
        "  - id: tell\n    type: notify.telegram\n    with: { text: hi }\n",
        "  - id: note\n    type: test.note\n    with: { text: x }\n",
      );
    const marks = pipelineMarks(before, after);
    expect([...marks.marked].sort()).toEqual(["note", "search", "trigger"]);
    expect(marks.changes).toEqual(["its trigger changed", "search changed", "note added", "tell removed"]);
    expect(pipelineMarks(before, before)).toEqual({ marked: new Set(), changes: [] });
  });

  it("marks an App's changed fields, new types and stages; lists pages and removals", () => {
    const before = `name: Bills
types:
  Bill:
    key: id
    fields:
      id: { type: text, required: true }
      amount: { type: number }
      note: { type: text }
`;
    const after = `${before.replace("amount: { type: number }", "amount: { type: money, currency: currency }\n      currency: { type: text }").replace("      note: { type: text }\n", "")}  Shop:
    key: name
    fields:
      name: { type: text }
pages:
  - list: Bill
`;
    const marks = appMarks(before, after);
    expect([...marks.marked].sort()).toEqual(["Bill.amount", "Bill.currency", "Shop"]);
    expect(marks.changes).toEqual(["Bill.amount changed", "Bill.currency added", "Bill.note removed", "Shop added", "its pages changed"]);
  });
});
