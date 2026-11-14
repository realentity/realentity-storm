import { type CompiledDefinition } from "@realentity/storm-shared";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { definitionToSource } from "./source";

describe("definitionToSource", () => {
  it("gives the steps as authored: no compiler-inserted gates, no empty defaults", () => {
    const definition: CompiledDefinition = {
      name: "Replies",
      trigger: "manual",
      limits: {},
      policy: { allowedDomains: [], allowedRecipients: ["me@example.org"] },
      steps: [
        { id: "search", type: "test.search", with: { query: "dotnet" }, retries: 2 },
        { id: "replyGate", type: "gate.act", forEach: "{{search.items}}", with: { for: "reply" }, autoInserted: true },
        { id: "reply", type: "test.send", forEach: "{{search.items}}", with: { to: "{{item.recruiter}}", body: "Thanks" } },
      ],
    };
    expect(parse(definitionToSource(definition))).toEqual({
      name: "Replies",
      policy: { allowedRecipients: ["me@example.org"] },
      steps: [
        { id: "search", type: "test.search", retries: 2, with: { query: "dotnet" } },
        { id: "reply", type: "test.send", forEach: "{{search.items}}", with: { to: "{{item.recruiter}}", body: "Thanks" } },
      ],
    });
  });

  it("keeps a schedule and limits", () => {
    const source = definitionToSource({
      name: "Digest",
      trigger: { schedule: "0 8 * * 1-5", tz: "Europe/Sofia" },
      limits: { "email.send": "10/day" },
      policy: { allowedDomains: [], allowedRecipients: [] },
      steps: [{ id: "tell", type: "notify.telegram", with: { text: "hi" } }],
    });
    expect(parse(source)).toMatchObject({ trigger: { schedule: "0 8 * * 1-5", tz: "Europe/Sofia" }, limits: { "email.send": "10/day" } });
  });

  // M50: an edit keeps the slots as they were declared (their labels, what they ask for)
  it("keeps the pipeline's slots", () => {
    const needs = {
      github: { kind: "credential" as const, type: "api_key" as const, for: "api.github.com", label: "GitHub, to open issues" },
      work: { kind: "google" as const, uses: ["calendar" as const], label: "The work calendar" },
    };
    const source = definitionToSource({
      name: "Issues",
      trigger: "manual",
      limits: {},
      policy: { allowedDomains: [], allowedRecipients: [] },
      needs,
      steps: [{ id: "tell", type: "notify.telegram", with: { text: "hi" } }],
    });
    expect(parse(source)).toMatchObject({ needs });
  });
});
