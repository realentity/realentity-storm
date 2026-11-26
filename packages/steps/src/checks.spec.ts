import { exampleYaml } from "@realentity/storm-shared/example-files";
import { AppDefinitionSchema, type CompileResult } from "@realentity/storm-shared";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { defaultCatalog } from "./catalog";
import { PipelineCompiler } from "./compiler";

const compiler = new PipelineCompiler(defaultCatalog());
const serverOps = AppDefinitionSchema.parse(parseYaml(exampleYaml("apps/server-ops.yaml")));

function ok(result: CompileResult): Extract<CompileResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got:\n${result.errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`);
  return result;
}

function errorsOf(result: CompileResult): string[] {
  if (result.ok) throw new Error("expected compile errors");
  return result.errors.map((e) => `${e.path}: ${e.message}`);
}

const WHY =
  "a check's address is written in the pipeline, or is exactly a field of mine of an App entity (a Monitor's url you " +
  "typed: {{item.url}} over data.read's items, or {{trigger.item.url}}), never from emails, pages or other steps";

// M47-U1, S1 (the compiler's half): a check's address is written in the pipeline or typed by the user
describe("checks (M47)", () => {
  it("marks the checks of your Monitors' addresses as the only ones that may reach a private address", () => {
    const result = ok(compiler.compile(parseYaml(exampleYaml("check-monitors.yaml")), { app: serverOps }));
    expect(result.policy.privateHosts).toEqual(["webCheck", "netCheck"]);
  });

  it("takes an address written in the pipeline (public only, at run time) or a field of mine; nothing else", () => {
    const check = (url: string, extra: object[] = [], forEach?: string) =>
      compiler.compile(
        { name: "P", app: "Server ops", steps: [...extra, { id: "check", type: "http.check", ...(forEach ? { forEach } : {}), with: { url } }] },
        { app: serverOps },
      );
    const written = ok(check("https://status.example.org/health"));
    expect(written.policy.privateHosts).toBeUndefined();

    const incidents = { id: "read", type: "data.read", with: { type: "Incident" } };
    const monitors = { id: "read", type: "data.read", with: { type: "Monitor" } };
    // An Incident's url is written by pipelines (from a webhook's body): never a check's address.
    expect(errorsOf(check("{{item.url}}", [incidents], "{{read.items}}"))).toEqual([`steps[1].with.url: {{item.url}} isn't a field of mine: ${WHY}`]);
    // A Monitor's name is its key, which pipelines write too; its url is mine.
    expect(errorsOf(check("{{item.name}}", [monitors], "{{read.items}}"))).toEqual([`steps[1].with.url: {{item.name}} isn't a field of mine: ${WHY}`]);
    ok(check("{{item.url}}", [monitors], "{{read.items}}"));
    // Built from a field, or from an email: never.
    expect(errorsOf(check("https://{{item.host}}/health", [monitors], "{{read.items}}"))).toEqual([`steps[1].with.url: ${WHY}`]);
    const mail = { id: "mail", type: "email.fetch", with: { mailbox: "INBOX" } };
    expect(errorsOf(check("{{item.text}}", [mail], "{{mail.messages}}"))).toEqual([`steps[1].with.url: {{item.text}} isn't a field of mine: ${WHY}`]);
  });

  it("takes {{trigger.item}}'s field of mine; never a webhook's body", () => {
    const run = (trigger: object, host: string) =>
      compiler.compile({ name: "P", app: "Server ops", trigger, steps: [{ id: "check", type: "net.check", with: { host, kind: "tcp", port: 443 } }] }, { app: serverOps });
    expect(ok(run({ on: "entity.action", type: "Monitor" }, "{{trigger.item.host}}")).policy.privateHosts).toEqual(["check"]);
    expect(errorsOf(run({ webhook: "token" }, "{{trigger.body.host}}"))).toEqual([`steps[0].with.host: {{trigger.body.host}} isn't a field of mine: ${WHY}`]);
    expect(errorsOf(run({ on: "entity.changed", type: "Incident" }, "{{trigger.item.subject}}"))).toEqual([
      `steps[0].with.host: {{trigger.item.subject}} isn't a field of mine: ${WHY}`,
    ]);
  });
});

// M59-T6: http.fetch reads a Feed's url you typed on its host, as a check reads a Monitor's
describe("an address of mine to read (M59-T6)", () => {
  const newsletter = AppDefinitionSchema.parse(parseYaml(exampleYaml("apps/newsletter.yaml")));
  const fetch = (url: string, extra: object[], forEach?: string) =>
    compiler.compile(
      { name: "P", app: "Newsletter", steps: [...extra, { id: "feeds", type: "http.fetch", ...(forEach ? { forEach } : {}), with: { url } }] },
      { app: newsletter },
    );

  it("marks a read of your Feeds' urls; collect-links needs no allowedDomains for them", () => {
    const collect = ok(compiler.compile(parseYaml(exampleYaml("collect-links.yaml")), { app: newsletter }));
    expect(collect.policy.ownHosts).toEqual(["feeds"]);
    expect(collect.policy.allowedDomains).toEqual([]);
    expect(ok(fetch("{{item.url}}", [{ id: "read", type: "data.read", with: { type: "Feed" } }], "{{read.items}}")).policy.ownHosts).toEqual(["feeds"]);
  });

  it("anything else is read as before, on allowedDomains only", () => {
    // A Link's url is written by pipelines (from emails and feeds): not mine.
    expect(ok(fetch("{{item.url}}", [{ id: "read", type: "data.read", with: { type: "Link" } }], "{{read.items}}")).policy.ownHosts).toBeUndefined();
    // Built from a field of mine: not exactly it.
    expect(ok(fetch("{{item.url}}?x=1", [{ id: "read", type: "data.read", with: { type: "Feed" } }], "{{read.items}}")).policy.ownHosts).toBeUndefined();
    const mail = { id: "mail", type: "email.fetch", with: { mailbox: "INBOX" } };
    expect(ok(fetch("{{item.text}}", [mail], "{{mail.messages}}")).policy.ownHosts).toBeUndefined();
  });
});
