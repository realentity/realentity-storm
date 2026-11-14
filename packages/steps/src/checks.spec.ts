import { AppDefinitionSchema, type CompileResult } from "@realentity/storm-shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { defaultCatalog } from "./catalog";
import { PipelineCompiler } from "./compiler";

const compiler = new PipelineCompiler(defaultCatalog());
const serverOps = AppDefinitionSchema.parse(parseYaml(readFileSync(join(__dirname, "../../../pipelines/apps/server-ops.yaml"), "utf8")));

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
    const result = ok(compiler.compile(parseYaml(readFileSync(join(__dirname, "../../../pipelines/check-monitors.yaml"), "utf8")), { app: serverOps }));
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
