import { config } from "dotenv";
import { addUsage, ClaudeChat, emptyUsage, ModelRouter, type ChatMessage, type LlmUsage } from "@ai-me/llm";
import { definitionToSource, type CompiledDefinition } from "@ai-me/shared";
import { defaultCatalog, diffDefinitions, PipelineCompiler } from "@ai-me/steps";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Builder, type TurnResult } from "../src/builder/builder";

/**
 * M7-V1 (README test strategy: LLM eval with the real Claude API, run by hand):
 *   pnpm --filter @ai-me/api eval:builder
 * The builder (its prompt, tools and model) recreates the hand-written pipelines from a plain description of what
 * they do, and the result must be equivalent: same trigger, steps, fan-out, gates, recipient provenance and limits.
 * Also: an edit in a pipeline's chat changes only what I asked (M7-T3), and a request the catalog can't serve yet is
 * answered with what is missing instead of a pipeline (M7-T2). M9-V3: the dev.bg job pipeline (applications included
 * since M10), from its description.
 * Writes evals/results/<date>-builder.json.
 */
config({ path: resolve(__dirname, "../../../.env"), quiet: true });

interface Case {
  name: string;
  description: string;
  /** The hand-written pipeline the result must match; null: no pipeline may be proposed. */
  expected: string | null;
  /** A pipeline-bound chat: this pipeline is the current version. */
  current?: string;
  /** The <saved_recipes> lines the builder sees (none by default). */
  recipes?: string;
}

const CASES: Case[] = [
  {
    name: "recruiter replies (M4)",
    expected: "recruiter-replies.yaml",
    description:
      "Every 15 minutes, read my new emails. Keep only those where a recruiter, hiring manager or client writes to me " +
      "personally about a role, a project, an interview or a contract and expects an answer; skip job alerts, " +
      "newsletters, notifications and mass mail. For each one, draft a short, warm reply as me: if it could fit, show " +
      "interest and ask for what is missing (rate, remote or on-site, start date, duration) and propose a short call; " +
      "if it clearly doesn't, decline politely in a sentence or two. I approve every reply before it goes out, as a " +
      "reply in the same thread. At most 20 replies a day.",
  },
  {
    name: "daily digest",
    expected: "daily-digest.yaml",
    description: "Every evening at 7, send me a Telegram digest of the last 24 hours: what ran, what waits for me and what failed.",
  },
  {
    name: "edit: check every 30 minutes (M7-T3)",
    expected: null,
    current: "recruiter-replies.yaml",
    description: "Check every 30 minutes instead.",
  },
  {
    name: "missing capability: downloading files (M7-T2)",
    expected: null,
    description: "Every Friday, download this week's invoices from my accounting portal and email them to my accountant.",
  },
  {
    name: "daily .NET jobs (M9-V3)",
    expected: "dev-bg-jobs.yaml",
    recipes: "- dev.bg/search v1: params category (dev.bg's category slug, e.g. net, java)",
    description:
      "Every weekday at 8, read the .NET jobs on dev.bg (category net) and keep only the ones I haven't seen before. " +
      "Label each as posted by a recruitment agency or by the employer itself, and save the agency ones as skipped. " +
      "Score the others against my profile: senior or lead .NET (C#) backend, ASP.NET Core, Azure, SQL, Sofia hybrid " +
      "or fully remote; no junior, front-end, QA, support or other stacks. Save every scored job, let me pick from the " +
      "best 10, and save the ones I pick as shortlisted. For each one I pick, read its application form and fill it from " +
      "my profile with my CV (the document cv-main) attached and a short message to the employer in the posting's " +
      "language (why the role fits me, from my profile only, 2-3 sentences); I approve the form, and the browser fills " +
      "it but leaves the final button to me. At most 5 applications a day, and only dev.bg itself is allowed without asking.",
  },
];

const FOLLOW_UP = "Use sensible defaults for anything still open and propose it.";

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  const catalog = defaultCatalog();
  const compiler = new PipelineCompiler(catalog);
  const builder = new Builder(ClaudeChat.fromApiKey(apiKey), compiler, catalog);
  const choice = await new ModelRouter(() => Promise.resolve(null), process.env).choose("eval", "builder");
  const load = (file: string): CompiledDefinition => {
    const compiled = compiler.compileText(readFileSync(resolve(__dirname, "../../../pipelines", file), "utf8"));
    if (!compiled.ok) throw new Error(`pipelines/${file} doesn't compile`);
    return compiled.definition;
  };

  let usage: LlmUsage = emptyUsage();
  const results = [];
  for (const c of CASES) {
    const current = c.current ? load(c.current) : null;
    const history: ChatMessage[] = [];
    const turns: TurnResult[] = [];
    const say = async (text: string, showCurrent: boolean) => {
      const shown = showCurrent && current ? `<current_pipeline version="1" id="eval">\n${definitionToSource(current)}</current_pipeline>\n\n` : "";
      const recipes = showCurrent ? `<saved_recipes>\n${c.recipes ?? "none yet"}\n</saved_recipes>\n\n` : "";
      const user: ChatMessage = { role: "user", content: [{ type: "text", text: `${shown}${recipes}${text}` }] };
      const turn = await builder.turn({ choice, history, user, current, runs: null, tokensLeft: 2_000_000 });
      usage = addUsage(usage, turn.usage);
      if (turn.transcript) history.push(user, ...turn.transcript);
      turns.push(turn);
      return turn;
    };

    let turn = await say(c.description, true);
    // Asking back is fine (M7-T2); one answer, then it must propose. Not for the missing-capability case.
    if (!turn.proposal && !turn.error && (c.expected || c.current)) turn = await say(FOLLOW_UP, false);

    const problems: string[] = [];
    const proposed = turn.proposal?.compiled.definition ?? null;
    if (turn.error) problems.push(`error: ${turn.error}`);
    if (c.expected) {
      if (!proposed) problems.push("no proposal");
      else problems.push(...differences(load(c.expected), proposed));
    } else if (current) {
      if (!proposed) problems.push("no proposal");
      else {
        const changes = diffDefinitions(current, proposed).changes;
        const expected = [{ kind: "pipeline", field: "trigger", before: current.trigger, after: { schedule: "*/30 * * * *", tz: "Europe/Sofia" } }];
        if (JSON.stringify(changes) !== JSON.stringify(expected)) problems.push(`changes: ${JSON.stringify(changes)}`);
      }
    } else {
      if (proposed) problems.push(`proposed a pipeline: ${proposed.steps.map((s) => s.type).join(", ")}`);
      if (!/download|file|attach|invoice/i.test(turns.map((t) => t.text).join(" "))) problems.push("didn't say what is missing");
    }

    const pass = problems.length === 0;
    console.log(`${pass ? "PASS" : "FAIL"} ${c.name} (${turns.length} turn(s))${pass ? "" : `\n  ${problems.join("\n  ")}`}`);
    results.push({
      name: c.name,
      pass,
      problems,
      turns: turns.map((t) => ({ text: t.text, proposal: t.proposal && definitionToSource(t.proposal.compiled.definition), compileErrors: t.compileErrors, costUsd: t.usage.costUsd })),
    });
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed · ${choice.model} (${choice.effort}) · $${usage.costUsd.toFixed(2)}`);
  const dir = resolve(__dirname, "results");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${new Date().toISOString().slice(0, 10)}-builder.json`);
  writeFileSync(file, `${JSON.stringify({ model: choice, passed, total: results.length, costUsd: usage.costUsd, results }, null, 2)}\n`);
  console.log(`Results: ${file}`);
  if (passed < results.length) process.exitCode = 1;
}

/**
 * What makes two pipelines equivalent: trigger, step types in order (gates included), what each step iterates over
 * and where each side-effect target comes from (as step types, so ids may differ), and limits. Wording of
 * instructions may differ.
 */
function differences(expected: CompiledDefinition, actual: CompiledDefinition): string[] {
  const problems: string[] = [];
  const same = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${what}: expected ${JSON.stringify(a)}, got ${JSON.stringify(b)}`);
  };
  same("trigger", expected.trigger, actual.trigger);
  same("steps", expected.steps.map((s) => s.type), actual.steps.map((s) => s.type));
  same("forEach", shape(expected).forEach, shape(actual).forEach);
  same("references", shape(expected).references, shape(actual).references);
  same("limits", expected.limits, actual.limits);
  return problems;
}

/** forEach sources and side-effect/draft inputs, with step ids replaced by step types. */
function shape(definition: CompiledDefinition) {
  const typeOf = new Map(definition.steps.map((s) => [s.id, s.type]));
  const typed = (value: unknown) =>
    typeof value === "string" ? value.replace(/\{\{\s*([a-zA-Z0-9_]+)/g, (_, id: string) => `{{${typeOf.get(id) ?? id}`) : value;
  const sideEffects = definition.steps.filter((s) => s.type === "email.send" || s.type === "email.draftReply");
  return {
    forEach: definition.steps.map((s) => typed(s.forEach ?? null)),
    references: sideEffects.map((s) =>
      Object.fromEntries(
        Object.entries(s.with)
          .filter(([key]) => ["to", "message", "subject", "body", "inReplyTo"].includes(key))
          .map(([key, value]) => [key, typed(value)]),
      ),
    ),
  };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
