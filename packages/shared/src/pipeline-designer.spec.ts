import {
  addStep,
  allowDomain,
  allowedDomainsOf,
  moveStep,
  notAllowedHost,
  removeStep,
  renameStep,
  setPipelineProperty,
  setStepInput,
  setStepOption,
  setTrigger,
  stepIdFor,
} from "./pipeline-designer";

const SOURCE = `# bills from email
name: Bills
trigger: { schedule: "0 8 * * *", tz: Europe/Sofia }
steps:
  - id: fetch
    type: email.fetch
    with: { sinceDays: 7 }        # a week back
  - id: read
    type: bill.read
    when: "{{fetch.messages}}"
    with:
      messages: "{{fetch.messages}}"
  - id: tell
    type: notify.telegram
    forEach: "{{read.bills}}"
    with: { text: "{{item.issuer}}: {{ read.total }} after {{fetch}}" }
`;

// M36-U: each step-builder edit gives the YAML expected, the rest as written
describe("the step builder's edits (M36-T2)", () => {
  it("names a step from its type, numbered when taken, never a reserved word", () => {
    expect(stepIdFor("email.fetch", [])).toBe("fetch");
    expect(stepIdFor("email.fetch", ["fetch", "fetch2"])).toBe("fetch3");
    expect(stepIdFor("flow.item", [])).toBe("itemStep");
  });

  it("adds a step at the end or after another", () => {
    expect(addStep(SOURCE, "llm.generate")).toBe(`${SOURCE}  - id: generate\n    type: llm.generate\n    with: {}\n`);
    const after = addStep(SOURCE, "email.fetch", 0);
    expect(after).toContain("    with: { sinceDays: 7 }        # a week back\n  - id: fetch2\n    type: email.fetch\n");
  });

  it("removes and moves steps", () => {
    expect(removeStep(SOURCE, 2)).toBe(SOURCE.slice(0, SOURCE.indexOf("  - id: tell")));
    const moved = moveStep(SOURCE, 0, 1);
    expect(moved.indexOf("id: read")).toBeLessThan(moved.indexOf("id: fetch"));
    expect(moved).toContain("    with: { sinceDays: 7 }        # a week back");
    expect(moveStep(SOURCE, 0, -1)).toBe(SOURCE);
    expect(() => removeStep("name: x\nsteps:\n  - { id: a, type: b.c }\n", 0)).toThrow(/needs a step/);
  });

  it("renames a step and every reference to it, and nothing else", () => {
    const edited = renameStep(SOURCE, 0, "mail");
    expect(edited).toBe(
      SOURCE.replace("  - id: fetch\n", "  - id: mail\n")
        .replaceAll("{{fetch.messages}}", "{{mail.messages}}")
        .replace("after {{fetch}}", "after {{mail}}"),
    );
    expect(renameStep(SOURCE, 1, "bills")).toContain("{{ bills.total }}");
    expect(() => renameStep(SOURCE, 0, "read")).toThrow(/already/);
    expect(() => renameStep(SOURCE, 0, "item")).toThrow(/can't be/);
    expect(() => renameStep(SOURCE, 0, "Bad")).toThrow(/can't be/);
  });

  it("sets and removes a step's inputs on their line", () => {
    expect(setStepInput(SOURCE, 0, "sinceDays", 3)).toBe(SOURCE.replace("{ sinceDays: 7 }        #", "{ sinceDays: 3 }        #"));
    expect(setStepInput(SOURCE, 0, "folder", "INBOX")).toContain("with: { sinceDays: 7, folder: INBOX } # a week back");
    expect(setStepInput(SOURCE, 1, "messages", undefined)).toContain('    when: "{{fetch.messages}}"\n    with: {}\n');
    expect(setStepInput(SOURCE, 1, "labels", ["a", "b"])).toContain("      labels: [ a, b ]\n".replace("[ a, b ]", "[a, b]"));
    const list = setStepInput(SOURCE, 1, "items", [{ id: 1 }]);
    expect(list).toContain("      items:\n        - id: 1\n");
  });

  it("writes a text of several lines with its templates as they are", () => {
    const edited = setStepInput(SOURCE, 1, "note", "Bills:\n{{read.total}} in { braces }");
    expect(edited).not.toContain("{ {");
    expect(edited).toContain("{{read.total}}");
    expect(setStepInput(SOURCE, 1, "labels", ["a", "b"])).toContain("      labels: [a, b]\n");
  });

  it("sets a step's when, forEach and retries before its with", () => {
    expect(setStepOption(SOURCE, 0, "when", "{{trigger.ok}}")).toContain('    type: email.fetch\n    when: "{{trigger.ok}}"\n    with:');
    expect(setStepOption(SOURCE, 1, "when", undefined)).not.toContain("when:");
    expect(setStepOption(SOURCE, 2, "retries", 2)).toContain('    forEach: "{{read.bills}}"\n    retries: 2\n    with:');
  });

  it("sets the trigger on one line, where it was or before the steps", () => {
    expect(setTrigger(SOURCE, { on: "entity.changed", type: "Bill", field: "status" })).toContain(
      "trigger: { on: entity.changed, type: Bill, field: status }\n",
    );
    expect(setTrigger(SOURCE, "manual")).toContain("trigger: manual\n");
    // The comment on the trigger's line stays with the new one.
    const commented = SOURCE.replace('trigger: { schedule: "0 8 * * *", tz: Europe/Sofia }', "trigger: manual      # by hand for now");
    expect(setTrigger(commented, { webhook: "token" })).toContain("trigger: { webhook: token } # by hand for now\n");
    const none = SOURCE.replace(/^trigger: .*\n/m, "");
    expect(setTrigger(none, { schedule: "0 9 * * *", tz: "Europe/Sofia" })).toContain(
      'name: Bills\ntrigger: { schedule: "0 9 * * *", tz: Europe/Sofia }\nsteps:',
    );
  });

  it("sets the name, App and description, a new one after the name", () => {
    expect(setPipelineProperty(SOURCE, "app", "Bills")).toContain("name: Bills\napp: Bills\ntrigger:");
    expect(setPipelineProperty(setPipelineProperty(SOURCE, "app", "Bills"), "app", "")).toBe(SOURCE);
    expect(setPipelineProperty(SOURCE, "description", "Bills, kept")).toContain("name: Bills\ndescription: Bills, kept\n");
  });

  // A site to read, allowed from its card: no YAML needed
  it("allows a site the pipeline reads, the policy made before the steps when it has none", () => {
    const allowed = allowDomain(SOURCE, "WWW.PostgreSQL.org");
    expect(allowed).toContain(
      'trigger: { schedule: "0 8 * * *", tz: Europe/Sofia }\npolicy:\n  allowedDomains: [www.postgresql.org]\nsteps:\n',
    );
    expect(allowedDomainsOf(allowed)).toEqual(["www.postgresql.org"]);
    // Once; a second one after it; removed again, the rest as written.
    expect(allowDomain(allowed, "www.postgresql.org")).toBe(allowed);
    const two = allowDomain(allowed, "github.com");
    expect(allowedDomainsOf(two)).toEqual(["www.postgresql.org", "github.com"]);
    expect(allowDomain(two, "github.com", false)).toBe(allowed);
    expect(allowDomain(SOURCE, "github.com", false)).toBe(SOURCE);
    expect(allowedDomainsOf("not: [yaml")).toEqual([]);

    expect(notAllowedHost("www.postgresql.org isn't in policy.allowedDomains: add it there to read from it")).toBe("www.postgresql.org");
    expect(notAllowedHost("something else")).toBeNull();
  });
});
