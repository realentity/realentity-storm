import { type CompiledDefinition, type CompiledPolicy, type StepTypeView } from "@ai-me/shared";
import { describe, expect, it } from "vitest";
import { dependencies, describeChange, describeTrigger, policySummary, stepGraph } from "./plan";

const APPLY: CompiledDefinition = {
  name: "Apply",
  trigger: { schedule: "0 8 * * 1-5", tz: "Europe/Sofia" },
  limits: { "test.submit": "5/day" },
  policy: { allowedDomains: [], allowedRecipients: [] },
  steps: [
    { id: "search", type: "test.search", with: { query: "dotnet" } },
    {
      id: "letter",
      type: "llm.generate",
      forEach: "{{search.items}}",
      with: { instruction: "Dear {{item.recruiter}}", context: "{{item}}" },
    },
    { id: "applyGate", type: "gate.act", forEach: "{{search.items}}", with: { for: "apply" }, autoInserted: true },
    { id: "apply", type: "test.submit", forEach: "{{search.items}}", with: { url: "{{item.applyUrl}}", letter: "{{ letter.text }}" } },
    { id: "tell", type: "notify.telegram", with: { text: "Applied: {{apply}}, password {{cred:site}}" } },
  ],
};

const POLICY: CompiledPolicy = {
  allowedDomains: ["jobs.example.org"],
  allowedRecipients: [],
  provenance: [{ stepId: "apply", field: "url", kind: "domain", source: "item.applyUrl" }],
};

/** A catalog entry with only what the plan reads. */
const step = (type: string, sideEffect = false, headed = false): StepTypeView => ({
  type,
  description: "",
  sideEffect,
  headed,
  category: type.split(".")[0],
  input: {},
  output: {},
  llmOutput: false,
  targets: {},
  credentials: false,
  pageFields: [],
  primary: [],
  entities: [],
});

const CATALOG: StepTypeView[] = [step("test.search"), step("llm.generate"), step("gate.act"), step("test.submit", true, true), step("notify.telegram")];

describe("plan", () => {
  it("finds the steps a step reads from, ignoring item, cred and unknown names", () => {
    const ids = new Set(APPLY.steps.map((s) => s.id));
    expect(dependencies(APPLY.steps[1], ids)).toEqual(["search"]);
    expect(dependencies(APPLY.steps[3], ids)).toEqual(["letter", "search"]);
    expect(dependencies(APPLY.steps[4], ids)).toEqual(["apply"]);
  });

  it("lays the graph out by data flow, with each gate before the step it guards", () => {
    expect(stepGraph(APPLY).layers).toEqual([["search"], ["letter", "applyGate"], ["apply"], ["tell"]]);
    expect(stepGraph(APPLY).edges).toContainEqual({ from: "applyGate", to: "apply" });
  });

  it("summarizes what the pipeline may do: side effects behind gates, targets, limits, headed browser", () => {
    expect(policySummary(APPLY, POLICY, CATALOG)).toEqual([
      "apply (test.submit) acts outside AI ME, once per item; it waits for my approval at applyGate.",
      "Allowed domains: jobs.example.org",
      "apply.url (domain) must come from {{item.applyUrl}}, never from LLM text.",
      "At most 5/day for test.submit",
      "Uses the headed browser: one such run at a time.",
    ]);
    const readOnly = { ...APPLY, steps: APPLY.steps.slice(0, 2), limits: {} };
    expect(policySummary(readOnly, { allowedDomains: [], allowedRecipients: [], provenance: [] }, CATALOG)).toEqual([
      "No side effects: nothing is sent, submitted or uploaded outside AI ME.",
    ]);
  });

  it("describes triggers and changes in words", () => {
    expect(describeTrigger("manual")).toBe("Manual: runs when I start it");
    expect(describeTrigger({ schedule: "0 8 * * 1-5", tz: "Europe/Sofia" })).toBe("On schedule 0 8 * * 1-5 (Europe/Sofia)");
    expect(describeTrigger({ on: "run.finished", pipeline: "Jobs" })).toBe('When "Jobs" finishes DONE');
    expect(describeTrigger({ on: "email.classified", label: ["recruiter"] })).toBe("When an email is labelled recruiter");
    expect(describeTrigger({ webhook: "hmac-sha256" })).toBe("On a webhook call (HMAC-SHA256 signature)");
    expect(describeChange({ kind: "step-changed", stepId: "search", field: "with.query", before: "dotnet", after: "golang" })).toBe(
      'step search with.query: "dotnet" → "golang"',
    );
    expect(describeChange({ kind: "policy", list: "allowedDomains", added: ["a.org"], removed: ["b.org"] })).toBe(
      "allowedDomains + a.org; allowedDomains − b.org",
    );
    expect(describeChange({ kind: "step-added", stepId: "g", type: "gate.act", autoInserted: true })).toBe(
      "added step g (gate.act), inserted by the compiler",
    );
  });
});
