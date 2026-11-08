import { config } from "dotenv";
import { addUsage, ClaudeClient, emptyUsage, ModelRouter, type LlmUsage } from "@realentity/storm-llm";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NO_LEARNING, type StepLearning } from "../src/learning/learning";
import { REFLECTION_SYSTEM, ReflectionAnswerSchema, reflectionPrompt, type ReflectedDecision } from "../src/learning/reflection";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { emailBlock } from "../src/steps/email-block";
import { DraftReplyStep } from "../src/steps/email-steps";
import { EMAILS, toMessage, type LabeledEmail } from "./email-dataset";

/**
 * M6-V1 (docs/design.md test strategy: LLM eval with the real Claude API, run by hand):
 *   pnpm --filter @realentity/storm-worker eval:learning
 * 10 seeded edits in which the user removed "I hope this finds you well" (and its Bulgarian twin) from drafts, and in the
 * English ones replaced the sign-off "Best regards" with "Cheers," → reflection (the nightly prompt and model, called
 * directly instead of through the Batch API) must suggest a rule for each → with the suggested rules active, drafts of
 * ten other emails must not contain the phrase, and the English ones must sign off with "Cheers,". Without the rules
 * the drafts don't sign off that way: that shows the rules are what changes them.
 * Writes evals/results/<date>-learning.json.
 */
const PHRASE = /hope (this|the|my|that) (message|email|e-mail|note)? ?finds you well|надявам се,? (че )?(сте|си) добре/i;
const CHEERS = /\n\s*cheers,?\s*$/i;
const PIPELINE_ID = "00000000-0000-4000-8000-0000000000e1";

config({ path: resolve(__dirname, "../../../.env"), quiet: true });

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in .env");

  const compiled = new PipelineCompiler(defaultCatalog()).compileText(
    readFileSync(resolve(__dirname, "../../../pipelines/recruiter-replies.yaml"), "utf8"),
  );
  if (!compiled.ok) throw new Error("pipelines/recruiter-replies.yaml doesn't compile");
  const draftWith = compiled.definition.steps.find((s) => s.id === "draft")!.with as { instruction: string };
  // Warm openings are where the phrase comes from; the rules have to win against this.
  const instruction = `${draftWith.instruction} Open with a warm, polite first sentence before getting to the point.`;

  const llm = ClaudeClient.fromApiKey(apiKey);
  const router = new ModelRouter(() => Promise.resolve(null), process.env);
  let usage: LlmUsage = emptyUsage();
  const context: StepContext = {
    runId: "eval",
    userId: "eval",
    pipelineId: PIPELINE_ID,
    stepId: "eval",
    stepKey: "draft",
    itemIndex: null,
    dryRun: true,
    recordUsage: (more) => (usage = addUsage(usage, more)),
    attention: NO_ATTENTION,
  };

  const replies = (lang: LabeledEmail["lang"]) => EMAILS.filter((e) => e.label === "reply" && e.lang === lang);
  const seeds = [...replies("en").slice(0, 7), ...replies("bg").slice(0, 3)];
  const heldOut = [...replies("en").slice(7, 13), ...replies("bg").slice(3, 7)];

  // 1. Ten edits: the draft opened with the phrase, what the user approved doesn't; English drafts now end with "Cheers,".
  const decisions: ReflectedDecision[] = seeds.map((email, i) => {
    const bg = email.lang === "bg";
    const name = email.fromName.split(" ")[0];
    const opener = bg ? "Надявам се, че сте добре." : "I hope this finds you well.";
    const body = bg
      ? `Благодаря за съобщението относно „${email.subject}“. Звучи интересно; бихте ли споделили бюджета и формата на работа?`
      : `Thank you for reaching out about "${email.subject}". It sounds interesting; could you share the rate range and whether it is remote?`;
    const [draftedSignOff, mySignOff] = bg ? ["Поздрави", "Поздрави"] : ["Best regards", "Cheers,"];
    const greeting = bg ? `Здравейте, ${name},` : `Hi ${name},`;
    return {
      kind: "EDITED",
      reason: null,
      decidedAt: new Date(Date.UTC(2026, 9, 20 + (i % 10), 9)),
      pipelineId: PIPELINE_ID,
      pipelineName: "Recruiter and client replies",
      stepKey: "send",
      fields: [
        {
          stepType: "email.draftReply",
          stepKey: "draft",
          field: "body",
          context: emailBlock(toMessage(email, i)),
          original: `${greeting}\n\n${opener} ${body}\n\n${draftedSignOff}`,
          approved: `${greeting}\n\n${body}\n\n${mySignOff}`,
        },
      ],
      originalPayload: {},
      finalPayload: {},
    };
  });

  // 2. Reflection: same system prompt, prompt, schema and model as the nightly batch.
  const reflection = await llm.structured({
    choice: await router.choose("eval", "reflection"),
    system: REFLECTION_SYSTEM,
    prompt: reflectionPrompt(decisions, []),
    schema: ReflectionAnswerSchema,
    maxTokens: 8_000,
  });
  usage = addUsage(usage, reflection.usage);
  const phraseRule = reflection.output.rules.find((r) => /finds you well|надявам се/i.test(r.text));
  const signOffRule = reflection.output.rules.find((r) => /cheers/i.test(r.text));
  console.log(`Reflection suggested ${reflection.output.rules.length} rule(s):`);
  for (const r of reflection.output.rules) console.log(`  - [${r.stepType ?? "all"}] ${r.text}`);

  // 3. Drafts of ten other emails, without and with the suggested rules active (as if the user approved them all).
  const draft = async (learning: StepLearning) => {
    const step = new DraftReplyStep(llm, router, learning);
    const bodies: { id: string; lang: string; body: string; hasPhrase: boolean; cheers: boolean }[] = [];
    for (const [i, email] of heldOut.entries()) {
      const { body } = (await step.execute({ message: toMessage(email, 100 + i), instruction }, context)) as { body: string };
      bodies.push({ id: email.id, lang: email.lang, body, hasPhrase: PHRASE.test(body), cheers: CHEERS.test(body) });
    }
    return bodies;
  };
  const suggested = reflection.output.rules.map((r) => r.text);
  const before = await draft(NO_LEARNING);
  const after = await draft({ rules: () => Promise.resolve(suggested), examples: () => Promise.resolve([]) });
  const counts = (drafts: typeof before) => ({
    drafts: drafts.length,
    withPhrase: drafts.filter((d) => d.hasPhrase).length,
    english: drafts.filter((d) => d.lang === "en").length,
    englishWithCheers: drafts.filter((d) => d.lang === "en" && d.cheers).length,
  });

  const report = {
    date: new Date().toISOString(),
    seededEdits: decisions.length,
    reflection: reflection.output,
    phraseRule: phraseRule?.text ?? null,
    signOffRule: signOffRule?.text ?? null,
    withoutRules: counts(before),
    withRules: counts(after),
    pass:
      Boolean(phraseRule) &&
      Boolean(signOffRule) &&
      after.every((d) => !d.hasPhrase) &&
      after.filter((d) => d.lang === "en").every((d) => d.cheers),
    drafts: { before, after },
    usage,
  };
  const dir = resolve(__dirname, "results");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${report.date.slice(0, 10)}-learning.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

  const { withoutRules: was, withRules: now } = report;
  console.log(`Drafts with the phrase: ${was.withPhrase}/${was.drafts} without the rules, ${now.withPhrase}/${now.drafts} with them`);
  console.log(
    `English drafts signed "Cheers,": ${was.englishWithCheers}/${was.english} without the rules, ` +
      `${now.englishWithCheers}/${now.english} with them`,
  );
  console.log(`M6-V1 ${report.pass ? "PASS" : "FAIL"} · cost $${usage.costUsd.toFixed(4)} · ${file}`);
  if (!report.pass) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
