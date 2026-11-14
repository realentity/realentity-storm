import { type CompileResult } from "@realentity/storm-shared";
import { defaultCatalog } from "./catalog";
import { PipelineCompiler } from "./compiler";

const compiler = new PipelineCompiler(defaultCatalog());

function errorsOf(result: CompileResult): string[] {
  if (result.ok) throw new Error("expected compile errors");
  return result.errors.map((e) => `${e.path}: ${e.message}`);
}

const pipeline = (command: string, steps: object[]) => ({ name: "P", trigger: { on: "telegram.command", command }, steps });

// M49-U1: a command's name, and what its message may be
describe("telegram.command (M49)", () => {
  it("is a name Telegram takes, never one of the bot's own", () => {
    const tell = [{ id: "tell", type: "notify.telegram", with: { text: "{{trigger.text}}" } }];
    expect(compiler.compile(pipeline("buy_milk2", tell)).ok).toBe(true);
    expect(errorsOf(compiler.compile(pipeline("Buy-milk", tell)))).toEqual(["trigger.command: lowercase letters, digits and _, at most 32, e.g. task"]);
    expect(errorsOf(compiler.compile(pipeline("run", tell)))).toEqual(["trigger.command: that is one of the Storm bot's own commands"]);
  });

  it("brings its text and file as data: never a target, never an unknown field", () => {
    expect(errorsOf(compiler.compile(pipeline("mail", [{ id: "mail", type: "email.send", with: { to: "{{trigger.text}}", subject: "Hi", body: "Hello" } }])))).toEqual([
      "steps[0].with.to: {{trigger.text}} can't be a target: a message's text is data, not an address",
    ]);
    expect(errorsOf(compiler.compile(pipeline("x", [{ id: "tell", type: "notify.telegram", with: { text: "{{trigger.caption}}" } }])))[0]).toContain("{{trigger.caption}}");
  });
});
