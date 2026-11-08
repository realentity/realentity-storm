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
});
