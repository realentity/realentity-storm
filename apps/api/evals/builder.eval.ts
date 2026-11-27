import { exampleFiles, exampleYaml } from "@realentity/storm-shared/example-files";
import { config } from "dotenv";
import { readAppPackage, readAppSource } from "@realentity/storm-shared";
import { addUsage, ClaudeChat, emptyUsage, ModelRouter, OpenAiApi, OpenAiChat, type ChatMessage, type LlmUsage } from "@realentity/storm-llm";
import { definitionToSource, type CompiledDefinition } from "@realentity/storm-shared";
import {
  appDifferences,
  capabilities,
  capabilitiesUsed,
  defaultCatalog,
  diffDefinitions,
  pipelineDifferences,
  PipelineCompiler,
  type AppWithPipelines,
} from "@realentity/storm-steps";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Builder, type TurnResult } from "../src/builder/builder";
import { ExampleLookups } from "../src/builder/example-lookups";

/**
 * M7-V1, M67-V1 (docs/design.md test strategy: LLM eval with the real Claude API, run by hand):
 *   pnpm --filter @realentity/storm-api eval:builder [--only <text>] [--runs 3] [--max-turns 4] [--list]
 *     [--model <a Claude model>] [--base-url http://localhost:11434/v1 --model qwen3:14b]
 * The builder (its prompt, tools and model) recreates each example App and pipeline from a plain description of it
 * (evals/builder-cases.json), and the result must be equivalent in what matters (@realentity/storm-steps'
 * appDifferences, pipelineDifferences). Also: an edit in a pipeline's chat changes only what was asked (M7-T3), and a
 * request the catalog can't serve yet is answered with what is missing instead of a pipeline (M7-T2).
 * --list prints the cases and the capability matrix (M67-T4) without calling the model.
 * Writes evals/results/<date>-builder.json (kept out of the repository).
 */
config({ path: resolve(__dirname, "../../../.env"), quiet: true });

interface Case {
  name: string;
  description: string;
  /** "apps/<id>.yaml": an App; "pipelines/<id>.yaml": a standalone pipeline; null: nothing may be proposed. */
  file: string | null;
  /** A pipeline-bound chat: this pipeline is the current version. */
  current?: string;
  /** The <saved_recipes> lines the builder sees (none by default). */
  recipes?: string;
  /** M67-T2: what the simulated user answers when the builder asks (facts the description left out). */
  answers?: string;
}

/** The cases: one per example App and pipeline (M67-T1), and the edit and missing-capability ones (M7). */
export function loadCases(): Case[] {
  const written = JSON.parse(readFileSync(resolve(__dirname, "builder-cases.json"), "utf8")) as Case[];
  return [
    ...written,
    { name: "edit: check every 30 minutes (M7-T3)", file: null, current: "recruiter-replies.yaml", description: "Check every 30 minutes instead." },
    {
      name: "missing capability: downloading files (M7-T2)",
      file: null,
      description: "Every Friday, download this week's invoices from my accounting portal and email them to my accountant.",
    },
  ];
}

/**
 * M67-T2: the simulated user. When the builder asks or says back what it will build (a brief, M70), it answers with the
 * case's facts once, then agrees; the builder must propose within `--max-turns`.
 */
function simulatedUser(c: Case, reply: number): string {
  const agree = "Use sensible defaults for anything still open. If you have said what you will build, that is agreed: propose it.";
  return reply === 1 && c.answers ? `${c.answers}

${agree}` : agree;
}
const catalog = defaultCatalog();
const compiler = new PipelineCompiler(catalog);

/** An example App with its pipelines, each compiled against it. */
function exampleApp(file: string): AppWithPipelines {
  const documents = readAppPackage(exampleFiles()[file.replace(/^apps\/|\.yaml$/g, "")]).documents;
  const app = readAppSource(documents[0].source);
  return { app, pipelines: documents.slice(1).map((d) => compiled(d.source, app)) };
}

function compiled(text: string, app?: ReturnType<typeof readAppSource>): CompiledDefinition {
  const result = compiler.compileText(text, app ? { app } : {});
  if (!result.ok) throw new Error(`An example doesn't compile: ${result.errors.map((e) => e.message).join("; ")}`);
  return result.definition;
}

const examplePipeline = (file: string) => compiled(exampleYaml(file.replace(/^pipelines\//, "")));

/** M67-T4: each capability, with the cases whose example uses it; the ones no case uses are gaps. */
function matrix(cases: Case[]): { covered: Record<string, string[]>; gaps: string[] } {
  const covered: Record<string, string[]> = Object.fromEntries(capabilities(catalog).map((c) => [c, []]));
  for (const c of cases) {
    if (!c.file) continue;
    const used = c.file.startsWith("apps/") ? capabilitiesUsed(exampleApp(c.file).app, exampleApp(c.file).pipelines) : capabilitiesUsed(null, [examplePipeline(c.file)]);
    for (const capability of used) (covered[capability] ??= []).push(c.name);
  }
  return { covered, gaps: Object.entries(covered).flatMap(([c, names]) => (names.length === 0 ? [c] : [])) };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // --only bills,tables: the cases whose name or file has any of these.
  const only = flag("--only")?.toLowerCase().split(",").map((o) => o.trim()).filter(Boolean);
  const runs = Number(flag("--runs") ?? 1);
  const cases = loadCases().filter((c) => !only || only.some((o) => c.name.toLowerCase().includes(o) || c.file?.includes(o)));
  const { covered, gaps } = matrix(loadCases());
  if (args.includes("--list")) {
    for (const c of cases) console.log(`${c.name}${c.file ? ` (${c.file})` : ""}`);
    console.log(`\n${cases.length} cases. Capabilities no case uses (${gaps.length}): ${gaps.join(", ") || "none"}`);
    return;
  }

  // The builder's model: Claude's default for it, another Claude model (--model), or a model on an OpenAI-compatible
  // server (--base-url http://localhost:11434/v1 --model qwen3:14b: Ollama, M60), which costs nothing.
  const baseUrl = flag("--base-url");
  const model = flag("--model");
  const defaults = await new ModelRouter(() => Promise.resolve(null)).choose("eval", "builder");
  let builder: Builder;
  let choice = defaults;
  if (baseUrl) {
    if (!model) throw new Error("--base-url needs --model (the model's name on that server)");
    builder = new Builder(new OpenAiChat(new OpenAiApi({ baseUrl, apiKey: process.env.LLM_OPENAI_API_KEY })), compiler, catalog);
    choice = { ...defaults, model: `openai:${model}` };
  } else {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in .env");
    builder = new Builder(ClaudeChat.fromApiKey(apiKey), compiler, catalog);
    if (model) choice = { ...defaults, model };
  }
  const maxTurns = Number(flag("--max-turns") ?? 4);

  let usage: LlmUsage = emptyUsage();
  const results: { name: string; run: number; pass: boolean; problems: string[]; costUsd: number; turns: unknown[] }[] = [];
  for (const c of cases) {
    for (let run = 1; run <= runs; run++) {
      const result = await runCase(c, builder, choice, maxTurns);
      usage = addUsage(usage, result.usage);
      const pass = result.problems.length === 0;
      console.log(`${pass ? "PASS" : "FAIL"} ${c.name}${runs > 1 ? ` [${run}/${runs}]` : ""} (${result.turns.length} turn(s), $${result.usage.costUsd.toFixed(2)})${pass ? "" : `\n  ${result.problems.join("\n  ")}`}`);
      results.push({ name: c.name, run, pass, problems: result.problems, costUsd: result.usage.costUsd, turns: result.turns });
    }
  }

  // M67's exit: a case passes in at least 2 of 3 runs (all runs, with fewer than 3).
  const byCase = cases.map((c) => {
    const mine = results.filter((r) => r.name === c.name);
    const passed = mine.filter((r) => r.pass).length;
    return { name: c.name, passed, runs: mine.length, pass: runs >= 3 ? passed * 3 >= runs * 2 : passed === mine.length };
  });
  const passing = byCase.filter((c) => c.pass).length;
  console.log(`\n${passing}/${byCase.length} cases pass · ${choice.model} (${choice.effort}) · $${usage.costUsd.toFixed(2)}`);
  console.log(`Capabilities no case uses (${gaps.length}): ${gaps.join(", ") || "none"}`);
  const dir = resolve(__dirname, "results");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${new Date().toISOString().slice(0, 16).replace(":", "")}-builder.json`);
  writeFileSync(file, `${JSON.stringify({ model: choice, runs, passing, total: byCase.length, costUsd: usage.costUsd, cases: byCase, gaps, covered, results }, null, 2)}\n`);
  console.log(`Results: ${file}`);
  if (passing < byCase.length) process.exitCode = 1;
}

/** One run of a case: the description, the simulated user's replies while it asks back, and what differs from the example. */
async function runCase(c: Case, builder: Builder, choice: Awaited<ReturnType<ModelRouter["choose"]>>, maxTurns: number) {
  const current = c.current ? examplePipeline(c.current) : null;
  const history: ChatMessage[] = [];
  const turns: TurnResult[] = [];
  let usage = emptyUsage();
  // M70-T3: the examples it may look up, not the one this case rebuilds: the eval measures building, not copying.
  const examples = new ExampleLookups(c.file?.startsWith("apps/") ? [c.file.replace(/^apps\/|\.yaml$/g, "")] : []);
  const lookups = { examples: () => examples.list(), example: (id: string) => examples.read(id), app: () => Promise.resolve(null) };
  const say = async (text: string, showCurrent: boolean) => {
    const shown = showCurrent && current ? `<current_pipeline version="1" id="eval">\n${definitionToSource(current)}</current_pipeline>\n\n` : "";
    const recipes = showCurrent ? `<saved_recipes>\n${c.recipes ?? "none yet"}\n</saved_recipes>\n\n` : "";
    const user: ChatMessage = { role: "user", content: [{ type: "text", text: `${shown}${recipes}${text}` }] };
    const turn = await builder.turn({ choice, history, user, current, runs: null, tokensLeft: 2_000_000, apps: [], lookups });
    usage = addUsage(usage, turn.usage);
    if (turn.transcript) history.push(user, ...turn.transcript);
    turns.push(turn);
    return turn;
  };

  let turn = await say(c.description, true);
  // Asking back and saying back what it will build are fine (M7-T2, M70); the simulated user answers until it proposes,
  // within maxTurns. Not for the missing-capability case: there it must say what is missing, not build around it.
  for (let reply = 1; reply < maxTurns && !turn.proposal && !turn.appProposal && !turn.error && (c.file || c.current); reply++) {
    turn = await say(simulatedUser(c, reply), false);
  }

  const problems: string[] = [];
  if (turn.error) problems.push(`error: ${turn.error}`);
  const proposed = turn.proposal?.compiled.definition ?? null;
  if (c.file?.startsWith("apps/")) {
    if (!turn.appProposal) problems.push(proposed ? "proposed a pipeline, not an App" : "no App proposed");
    else problems.push(...appDifferences(exampleApp(c.file), { app: turn.appProposal.app, pipelines: turn.appProposal.pipelines.map((p) => p.definition) }, catalog));
  } else if (c.file) {
    if (!proposed) problems.push("no proposal");
    else problems.push(...pipelineDifferences(examplePipeline(c.file), proposed, catalog));
  } else if (current) {
    if (!proposed) problems.push("no proposal");
    else {
      const changes = diffDefinitions(current, proposed).changes;
      const expected = [{ kind: "pipeline", field: "trigger", before: current.trigger, after: { schedule: "*/30 * * * *", tz: "Europe/Sofia" } }];
      if (JSON.stringify(changes) !== JSON.stringify(expected)) problems.push(`changes: ${JSON.stringify(changes)}`);
    }
  } else {
    if (proposed || turn.appProposal) problems.push("proposed something");
    // Said in the answer, or in the brief's "cannot" (M70-T2).
    const said = turns.map((t) => [t.text, ...(t.brief?.cannot ?? [])].join(" ")).join(" ");
    if (!/download|file|attach|invoice/i.test(said)) problems.push("didn't say what is missing");
  }
  return {
    problems,
    usage,
    turns: turns.map((t) => ({
      text: t.text,
      proposal: t.proposal && definitionToSource(t.proposal.compiled.definition),
      appProposal: t.appProposal && { source: t.appProposal.source, pipelines: t.appProposal.pipelines.map((p) => definitionToSource(p.definition)) },
      brief: t.brief,
      compileErrors: t.compileErrors,
      costUsd: t.usage.costUsd,
    })),
  };
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
