import { config } from "dotenv";
import { addUsage, ClaudeClient, emptyUsage, ModelRouter, type LlmUsage } from "@ai-me/llm";
import { defaultCatalog, PipelineCompiler, type EmailMessage } from "@ai-me/steps";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { DraftReplyStep, emailBlock, EmailClassifyStep } from "../src/steps/email-steps";
import { EMAILS, toMessage, type LabeledEmail } from "./email-dataset";

/**
 * M4-V1 and M4-V2 (README test strategy: LLM eval with the real Claude API, run by hand):
 *   pnpm --filter @ai-me/worker eval:email            both evals
 *   pnpm --filter @ai-me/worker eval:email classify   classification only (cheap: Haiku)
 * Uses the instructions of pipelines/recruiter-replies.yaml, the models from .env/defaults, and writes
 * evals/results/<date>-email.json.
 */
const CLASSIFY_TARGET = 0.9;

config({ path: resolve(__dirname, "../../../.env"), quiet: true });

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  const only = process.argv[2];

  const compiled = new PipelineCompiler(defaultCatalog()).compileText(
    readFileSync(resolve(__dirname, "../../../pipelines/recruiter-replies.yaml"), "utf8"),
  );
  if (!compiled.ok) throw new Error("pipelines/recruiter-replies.yaml doesn't compile");
  const stepWith = (id: string) => compiled.definition.steps.find((s) => s.id === id)!.with;

  const llm = ClaudeClient.fromApiKey(apiKey);
  const router = new ModelRouter(() => Promise.resolve(null), process.env);
  let usage: LlmUsage = emptyUsage();
  const context: StepContext = {
    runId: "eval",
    userId: "eval",
    pipelineId: "eval",
    stepId: "eval",
    stepKey: "eval",
    itemIndex: null,
    dryRun: true,
    recordUsage: (more) => (usage = addUsage(usage, more)),
    attention: NO_ATTENTION,
  };
  const report: Record<string, unknown> = { date: new Date().toISOString(), emails: EMAILS.length };

  // M4-V1: classification accuracy, overall and per language.
  const triage = stepWith("triage") as { instruction: string; labels: string[]; keep: string[] };
  const messages = EMAILS.map(toMessage);
  const classified = (await new EmailClassifyStep(llm, router).execute({ ...triage, messages }, context)) as {
    results: { index: number; label: string; reason: string }[];
  };
  const wrong = classified.results.filter((r) => r.label !== EMAILS[r.index].label);
  const accuracy = (subset: LabeledEmail[]) => {
    const ids = new Set(subset.map((e) => e.id));
    const inSubset = classified.results.filter((r) => ids.has(EMAILS[r.index].id));
    return inSubset.filter((r) => r.label === EMAILS[r.index].label).length / inSubset.length;
  };
  const classification = {
    model: (await router.choose("eval", "email.classify")).model,
    accuracy: accuracy(EMAILS),
    en: accuracy(EMAILS.filter((e) => e.lang === "en")),
    bg: accuracy(EMAILS.filter((e) => e.lang === "bg")),
    target: CLASSIFY_TARGET,
    misclassified: wrong.map((r) => ({ id: EMAILS[r.index].id, expected: EMAILS[r.index].label, got: r.label, reason: r.reason })),
    costUsd: usage.costUsd,
  };
  report.classification = classification;
  console.log(
    `V1 classification (${classification.model}): ${pct(classification.accuracy)} (en ${pct(classification.en)}, bg ${pct(classification.bg)}), target ${pct(CLASSIFY_TARGET)}`,
  );
  for (const miss of classification.misclassified)
    console.log(`  ✗ ${miss.id}: expected ${miss.expected}, got ${miss.got} (${miss.reason})`);

  // M4-V2: drafts keep the email's language and invent no facts (an LLM judge with a rubric).
  if (only !== "classify") {
    const before = usage.costUsd;
    const draftWith = stepWith("draft") as { instruction: string; context?: unknown; signature?: string };
    const drafter = new DraftReplyStep(llm, router);
    const judgeChoice = await router.choose("eval", "email.draftReply");
    const drafts = [];
    for (const [index, email] of EMAILS.entries()) {
      if (email.label !== "reply") continue;
      const draft = (await drafter.execute({ ...draftWith, message: messages[index] }, context)) as { body: string; language: string };
      const scriptOk = languageOf(draft.body) === email.lang;
      const verdict = await judge(
        llm,
        judgeChoice,
        messages[index],
        draftWith.instruction,
        draftWith.context,
        draft.body,
        (more) => (usage = addUsage(usage, more)),
      );
      drafts.push({
        id: email.id,
        lang: email.lang,
        reportedLanguage: draft.language,
        languageOk: scriptOk,
        unsupported: verdict.unsupported,
        body: draft.body,
      });
      console.log(
        `  ${scriptOk && verdict.unsupported.length === 0 ? "✓" : "✗"} ${email.id}${scriptOk ? "" : " (wrong language)"}${verdict.unsupported.map((u) => `\n      invented: ${u}`).join("")}`,
      );
    }
    const languageRate = drafts.filter((d) => d.languageOk).length / drafts.length;
    const factsRate = drafts.filter((d) => d.unsupported.length === 0).length / drafts.length;
    report.drafts = {
      model: (await router.choose("eval", "email.draftReply")).model,
      judge: judgeChoice.model,
      languageRate,
      factsRate,
      costUsd: usage.costUsd - before,
      items: drafts,
    };
    console.log(`V2 drafts: language kept ${pct(languageRate)}, no invented facts ${pct(factsRate)} (${drafts.length} drafts)`);
  }

  report.costUsd = usage.costUsd;
  console.log(`Cost: $${usage.costUsd.toFixed(4)}`);
  const dir = resolve(__dirname, "results");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${new Date().toISOString().slice(0, 10)}-email${only ? `-${only}` : ""}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Results: ${file}`);
}

const Verdict = z.object({
  unsupported: z.array(z.string()).describe("each factual claim in the reply that the email, instruction and background don't support"),
});

/** Rubric judge: what in the reply isn't backed by the email, my instruction or my background (placeholders are fine). */
async function judge(
  llm: ClaudeClient,
  choice: Awaited<ReturnType<ModelRouter["choose"]>>,
  message: EmailMessage,
  instruction: string,
  background: unknown,
  reply: string,
  record: (usage: LlmUsage) => void,
): Promise<z.infer<typeof Verdict>> {
  const result = await llm.structured({
    choice,
    system:
      "You check an email reply drafted for a user. List every factual claim in the reply that is not supported by the " +
      "original email, the user's instruction or the user's background: dates, times, prices, rates, salaries, availability, " +
      "names, links, experience, commitments. Placeholders in square brackets like [date] are fine, as are greetings, " +
      "politeness, questions, an offer to talk, and showing interest or declining as the instruction asks. Return an empty " +
      "list when everything is supported.",
    prompt: [
      emailBlock(message),
      `<instruction>${instruction}</instruction>`,
      `<background>${background === undefined ? "(none)" : JSON.stringify(background)}</background>`,
      `<reply>\n${reply}\n</reply>`,
    ].join("\n"),
    schema: Verdict,
  });
  record(result.usage);
  return result.output;
}

/** Bulgarian or English by script: the share of Cyrillic among letters. */
export function languageOf(text: string): "bg" | "en" {
  const letters = text.replace(/\[[^\]]*\]/g, "").match(/\p{L}/gu) ?? [];
  const cyrillic = letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length;
  return cyrillic > letters.length / 2 ? "bg" : "en";
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
