import { type CompiledDefinition } from "@realentity/storm-shared";
import { diffDefinitions } from "./diff";

const base: CompiledDefinition = {
  name: "Jobs",
  trigger: { schedule: "0 8 * * 1-5", tz: "Europe/Sofia" },
  limits: { "llm.score": "100/day" },
  policy: { allowedDomains: ["jobs.bg"], allowedRecipients: [] },
  steps: [
    { id: "search", type: "test.search", with: { query: { keywords: "senior .NET", locations: ["Sofia", "Remote"] } } },
    { id: "score", type: "llm.score", with: { items: "{{search.items}}", against: "profile", top: 10 } },
    { id: "notify", type: "notify.telegram", with: { text: "done" } },
  ],
};

describe("diffDefinitions", () => {
  it("finds nothing between identical versions, regardless of key order", () => {
    const reordered: CompiledDefinition = {
      ...base,
      steps: base.steps.map((s) => ({ with: s.with, type: s.type, id: s.id })),
    };
    expect(diffDefinitions(base, reordered)).toEqual({ changes: [], summary: "" });
  });

  it('describes "Also include Plovdiv" as a parameter change of the search step', () => {
    const next: CompiledDefinition = {
      ...base,
      steps: base.steps.map((s) =>
        s.id === "search" ? { ...s, with: { query: { keywords: "senior .NET", locations: ["Sofia", "Remote", "Plovdiv"] } } } : s,
      ),
    };
    const diff = diffDefinitions(base, next);
    expect(diff.changes).toEqual([
      {
        kind: "step-changed",
        stepId: "search",
        field: "with.query",
        before: { keywords: "senior .NET", locations: ["Sofia", "Remote"] },
        after: { keywords: "senior .NET", locations: ["Sofia", "Remote", "Plovdiv"] },
      },
    ]);
    expect(diff.summary).toMatch(/^step search: with\.query .*Plovdiv/);
  });

  it("reports added, removed and moved steps, trigger, limit and policy changes", () => {
    const next: CompiledDefinition = {
      ...base,
      trigger: "manual",
      limits: { "llm.score": "50/day", "test.send": "5/day" },
      policy: { allowedDomains: ["dev.bg"], allowedRecipients: [] },
      steps: [
        base.steps[2],
        base.steps[0],
        { id: "sendGate", type: "gate.act", with: { for: "send" }, autoInserted: true },
        { id: "send", type: "test.send", with: { to: "me@example.com", body: "x" } },
      ],
    };
    const kinds = diffDefinitions(base, next).changes.map((c) => c.kind);
    expect(kinds).toEqual(["pipeline", "limit", "limit", "policy", "step-removed", "step-added", "step-added", "step-moved", "step-moved"]);
    expect(diffDefinitions(base, next).summary).toMatch(/step sendGate \(gate\.act\) added automatically/);
  });
});
