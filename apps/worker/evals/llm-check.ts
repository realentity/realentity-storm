import { type PrismaClient, type TopicFact } from "@realentity/storm-db";
import { addUsage, emptyUsage, llmFromConfig, ModelRouter, toolResult, toolUses, type ChatMessage, type LlmUsage } from "@realentity/storm-llm";
import { exampleYaml } from "@realentity/storm-shared/example-files";
import { defaultCatalog, PipelineCompiler, type EmailMessage } from "@realentity/storm-steps";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { z } from "zod";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { type AppFileStore } from "../src/steps/app-file-steps";
import { DraftReplyStep, EmailClassifyStep } from "../src/steps/email-steps";
import { ClassifyStep, ExtractStep, GenerateStep, ScoreStep, SummarizeStep } from "../src/steps/llm-steps";
import { emailEvidence, extractRequest, SCREEN, SCREEN_SCHEMA, screenBlock, type TopicCard } from "../src/steps/topic-memory-steps";
import { EMAILS, toMessage } from "./email-dataset";

/**
 * M60-T6: does a model do Storm's LLM work? Each check runs a real step (its own prompt and schema) on made-up data
 * and checks the answer, `--runs` times; the table says how often each passed and how long it took.
 *
 *   pnpm --filter @realentity/storm-worker llm:check --model openai:qwen3:14b --base-url http://localhost:11434/v1
 *   pnpm --filter @realentity/storm-worker llm:check --model claude-haiku-5-5 --runs 1 --only llm.extract,tools
 *
 * Every task gets the model under test. `--base-url` (else OPENAI_BASE_URL) is the OpenAI-compatible server for
 * `openai:` models; Claude needs ANTHROPIC_API_KEY. Writes evals/results/<date>-llm-check-<model>.json.
 */
config({ path: resolve(__dirname, "../../../.env"), quiet: true });

const { values: args } = parseArgs({
  options: {
    model: { type: "string" },
    "base-url": { type: "string" },
    runs: { type: "string", default: "3" },
    only: { type: "string" },
  },
});
if (!args.model) throw new Error("--model is required: openai:<name> or a Claude model id");
const MODEL = args.model;
const RUNS = Math.max(1, Number(args.runs));

const llm = llmFromConfig({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiBaseUrl: args["base-url"] ?? process.env.OPENAI_BASE_URL,
  openaiApiKey: process.env.OPENAI_API_KEY,
});
/** The model under test for every task, at the task's usual effort. */
const defaults = new ModelRouter(() => Promise.resolve(null));
const router = new ModelRouter(async (_userId, taskKey) => ({ model: MODEL, effort: defaults.fallback(taskKey).effort }));

interface Outcome {
  ok: boolean;
  detail: string;
}
interface Check {
  task: string;
  /** What it shows, for the table. */
  what: string;
  run(context: StepContext): Promise<Outcome>;
}

const pass = (detail = ""): Outcome => ({ ok: true, detail });
const fail = (detail: string): Outcome => ({ ok: false, detail });

function message(id: string, from: string, fromName: string, subject: string, text: string, date = "2026-11-20T09:00:00.000Z"): EmailMessage {
  const messageId = `<${id}@check.example>`;
  return { uid: 1, messageId, threadId: messageId, inReplyTo: null, references: [], from, fromName, replyTo: from, to: ["me@example.org"], cc: [], subject, date, text, attachments: [] };
}

const CHECKS: Check[] = [
  {
    task: "llm.classify",
    what: "8 items, 3 labels: at least 7 right",
    async run(context) {
      const items = [
        { text: "Your electricity bill for October: 84.20 EUR, due 5 December", want: "bill" },
        { text: "This week in Rust: async closures land, and 12 new crates", want: "newsletter" },
        { text: "Mum: are you coming for dinner on Sunday?", want: "personal" },
        { text: "Water supply invoice no. 4471, amount 23.10 EUR", want: "bill" },
        { text: "The Weekly Gardener #212: pruning roses in winter", want: "newsletter" },
        { text: "Hey, it's Petar, can I borrow your drill tomorrow?", want: "personal" },
        { text: "Internet subscription: your invoice for November is ready, 19.99 EUR", want: "bill" },
        { text: "Product Hunt Daily: the 5 best launches of today", want: "newsletter" },
      ];
      const out = (await new ClassifyStep(llm.client, router).execute(
        { items: items.map(({ text }) => ({ text })), instruction: "What kind of message is it?", labels: ["bill", "newsletter", "personal"], keep: ["bill"] },
        context,
      )) as { results: { index: number; label: string }[] };
      const right = out.results.filter((r) => r.label === items[r.index].want).length;
      return right >= 7 ? pass(`${right}/8`) : fail(`${right}/8 right`);
    },
  },
  {
    task: "llm.score",
    what: "4 job posts against a profile: the best first, the worst last",
    async run(context) {
      const items = [
        { title: "Junior PHP developer, on site in Lyon", id: "worst" },
        { title: "Senior TypeScript backend engineer (Node.js, PostgreSQL), fully remote within the EU", id: "best" },
        { title: "Java developer, hybrid in Vienna, 3 days in the office", id: "mid1" },
        { title: "Full-stack engineer, React and Node.js, remote from Europe", id: "mid2" },
      ];
      const out = (await new ScoreStep(llm.client, router).execute(
        { items, against: "Senior backend engineer, TypeScript and Node.js, PostgreSQL, wants fully remote work from the EU", outcomes: false },
        context,
      )) as { top: { id: string; score: number }[] };
      const order = out.top.map((t) => t.id);
      return order[0] === "best" && order[3] === "worst" ? pass(order.join(" > ")) : fail(`order ${order.join(" > ")}`);
    },
  },
  {
    task: "llm.extract",
    what: "an invoice email: amount, due date, issuer, reference",
    async run(context) {
      const content =
        "From: billing@power.example\nSubject: Your invoice 2026-11-0457\nDate: 20 November 2026\n\nDear customer,\n\nyour electricity invoice no. 2026-11-0457 " +
        "for October 2026 is 84.20 EUR. Please pay by 5 December 2026 to IBAN XX00 EXAM 0000 0000 0000 00.\n\nExample Power Ltd.";
      const out = (await new ExtractStep(llm.client, router).execute(
        {
          content,
          fields: { amount: "the amount to pay, a number", dueDate: "when it must be paid, a date", issuer: "who sent the bill", reference: "the invoice number" },
          timeZone: "Europe/Berlin",
        },
        context,
      )) as { values: Record<string, string> };
      const v = out.values;
      const wrong = [
        !/84[.,]20?/.test(v.amount) && `amount "${v.amount}"`,
        !v.dueDate.startsWith("2026-12-05") && `dueDate "${v.dueDate}"`,
        !/example power/i.test(v.issuer) && `issuer "${v.issuer}"`,
        !v.reference.includes("2026-11-0457") && `reference "${v.reference}"`,
      ].filter(Boolean);
      return wrong.length === 0 ? pass() : fail(wrong.join(", "));
    },
  },
  {
    task: "llm.extract (scan)",
    what: "a warranty card as an image (Papers): product, purchase date, warranty end",
    async run(context) {
      const scan = await warrantyCard();
      const store = { read: () => Promise.resolve({ row: { filename: "warranty.png", mime: "image/png" }, content: scan }) } as unknown as AppFileStore;
      const out = (await new ExtractStep(llm.client, router).withFiles({} as PrismaClient, store).execute(
        {
          files: ["warranty.png"],
          fields: { product: "what was bought", purchased: "the date of purchase", warrantyEnds: "the date the warranty ends" },
          timeZone: "Europe/Berlin",
        },
        context,
      )) as { values: Record<string, string> };
      const v = out.values;
      const wrong = [
        !/washing machine|wm-?8/i.test(v.product) && `product "${v.product}"`,
        !v.purchased.startsWith("2025-03-14") && `purchased "${v.purchased}"`,
        !v.warrantyEnds.startsWith("2027-03-14") && `warrantyEnds "${v.warrantyEnds}"`,
      ].filter(Boolean);
      return wrong.length === 0 ? pass() : fail(wrong.join(", "));
    },
  },
  {
    task: "llm.summarize",
    what: "a long email in at most 40 words, keeping the decision",
    async run(context) {
      const content =
        "Hi all, following up on yesterday's long call about the website relaunch. We went through the three hosting offers again. " +
        "The first was cheapest but has no support in our time zone; the second had the best support but costs twice as much; the third is " +
        "in between and offers a migration service. After a long discussion we decided to go with the third offer, Example Hosting, and " +
        "to start the migration on 8 January. Ana will sign the contract this week. Please send me any concerns by Friday. Thanks, Ivo";
      const out = (await new SummarizeStep(llm.client, router).execute({ content, maxWords: 40 }, context)) as { summary: string };
      const words = out.summary.split(/\s+/).filter(Boolean).length;
      if (words > 48) return fail(`${words} words`);
      return /example hosting|third/i.test(out.summary) && /8 jan|january/i.test(out.summary) ? pass(`${words} words`) : fail(`left out the decision: ${out.summary}`);
    },
  },
  {
    task: "llm.generate",
    what: "a short plain-text note following an instruction",
    async run(context) {
      const out = (await new GenerateStep(llm.client, router).execute(
        { instruction: "Write two sentences for my neighbours: the water will be off on Saturday from 9 to 12 for a repair.", format: "text" },
        context,
      )) as { text: string };
      if (/\*\*|^#/m.test(out.text)) return fail("Markdown in plain text");
      return /saturday/i.test(out.text) && /9/.test(out.text) && out.text.length < 600 ? pass() : fail(out.text.slice(0, 160));
    },
  },
  {
    task: "email.classify",
    what: "12 labelled emails (en, bg), a real triage instruction: at least 10 right",
    async run(context) {
      const compiled = new PipelineCompiler(defaultCatalog()).compileText(exampleYaml("recruiter-replies.yaml"));
      if (!compiled.ok) throw new Error("examples/pipelines/recruiter-replies.yaml doesn't compile");
      const triage = compiled.definition.steps.find((s) => s.id === "triage")!.with;
      const sample = [...EMAILS.filter((e) => e.label === "reply").slice(0, 6), ...EMAILS.filter((e) => e.label === "skip").slice(0, 6)];
      const out = (await new EmailClassifyStep(llm.client, router).execute({ ...triage, messages: sample.map(toMessage) }, context)) as {
        results: { index: number; label: string }[];
      };
      const right = out.results.filter((r) => r.label === sample[r.index].label).length;
      return right >= 10 ? pass(`${right}/12`) : fail(`${right}/12 right`);
    },
  },
  {
    task: "email.draftReply",
    what: "a client's question answered from the agreed facts, nothing made up",
    async run(context) {
      const email = message(
        "draft-en",
        "lena@client.example",
        "Lena Novak",
        "Delivery of the mobile app",
        "Hi,\n\nCould you remind me when we get the first test version of the app, and whether the price we agreed includes the iOS version?\n\nThanks,\nLena",
      );
      const out = (await new DraftReplyStep(llm.client, router).execute(
        {
          message: email,
          instruction: "Answer the client's questions.",
          context: "Agreed with Lena on 3 November: the first test version is delivered on 15 December 2026. The agreed price covers Android and iOS.",
        },
        context,
      )) as { body: string; language: string };
      const wrong = [
        out.language !== "en" && `language ${out.language}`,
        !/15/.test(out.body) && "no delivery date",
        !/ios/i.test(out.body) && "no answer about iOS",
        /\d[\d.,]*\s?(€|eur|usd|\$)/i.test(out.body) && "a made-up price",
      ].filter(Boolean);
      return wrong.length === 0 ? pass() : fail(wrong.join(", "));
    },
  },
  {
    task: "email.draftReply (bg)",
    what: "a Bulgarian email answered in Bulgarian",
    async run(context) {
      const email = message(
        "draft-bg",
        "georgi@firma.example",
        "Георги Петров",
        "Среща следващата седмица",
        "Здравейте,\n\nМожем ли да се срещнем следващата седмица, за да обсъдим офертата? Кога ви е удобно?\n\nПоздрави,\nГеорги",
      );
      const out = (await new DraftReplyStep(llm.client, router).execute({ message: email, instruction: "Agree to meet; leave the time to me." }, context)) as {
        body: string;
        language: string;
      };
      const cyrillic = (out.body.match(/[Ѐ-ӿ]/g) ?? []).length / Math.max(1, (out.body.match(/\p{L}/gu) ?? []).length);
      return out.language === "bg" && cyrillic > 0.8 ? pass() : fail(`language ${out.language}, ${Math.round(cyrillic * 100)}% Cyrillic`);
    },
  },
  {
    task: "topic.extract",
    what: "screens two emails, then proposes the changed launch date as a change of the known fact",
    async run(context) {
      const topic = { topicId: "t-atlas", name: "Atlas", description: "The Atlas web shop project for a client" };
      const fact = (id: string, about: string, statement: string) =>
        ({ topicFactId: id, about, statement, source: "USER", sourceLabel: "the user", sourceDate: new Date("2026-10-01"), status: "ACTIVE" }) as unknown as TopicFact;
      const card: TopicCard = { ...topic, facts: [fact("f1", "Launch date", "15 March 2027"), fact("f2", "Payment provider", "Example Pay")], wrong: [] };
      const moved = emailEvidence(
        message(
          "topic-1",
          "pm@client.example",
          "Mira",
          "Atlas: new launch date",
          "Hi,\n\nafter the board meeting today we decided to move the Atlas launch to 12 April 2027, to have time for the payment tests.\n\nMira",
        ),
        [topic],
      );
      const smallTalk = emailEvidence(message("topic-2", "pm@client.example", "Mira", "Re: thanks", "Thanks, have a nice weekend!\n\nMira"), [topic]);
      const screened = await llm.client.structured({
        choice: await router.choose("check", "topic.extract.screen"),
        system: SCREEN,
        prompt: [screenBlock(moved, 0), screenBlock(smallTalk, 1)].join("\n\n"),
        schema: SCREEN_SCHEMA,
      });
      context.recordUsage(screened.usage);
      const worth = screened.output.results.sort((a, b) => a.index - b.index).map((r) => r.worth);
      if (worth.join() !== "true,false") return fail(`screen said ${worth.join(", ")}`);

      const request = extractRequest(moved, new Map([[topic.topicId, card]]));
      const answer = await llm.client.structured({ choice: await router.choose("check", "topic.extract"), ...request });
      context.recordUsage(answer.usage);
      const proposals = request.read(answer.output);
      const change = proposals.find((p) => /launch/i.test(p.about) && /12 april 2027|2027-04-12/i.test(p.statement));
      if (!change) return fail(`no launch date proposal: ${JSON.stringify(answer.output.proposals).slice(0, 200)}`);
      const raw = answer.output.proposals.find((p) => /launch/i.test(p.about));
      return raw?.kind === "change" && raw.replaces === "F1" ? pass() : fail(`kind ${raw?.kind}, replaces ${raw?.replaces}`);
    },
  },
  {
    task: "tools",
    what: "tool calls in a conversation (the builder, browser.agent): add, then finish with the sum",
    async run(context) {
      const tools = [
        { name: "add", description: "Adds two numbers and returns the sum.", input: z.object({ a: z.number(), b: z.number() }) },
        { name: "finish", description: "Ends the task with the answer.", input: z.object({ answer: z.string() }) },
      ];
      const choice = await router.choose("check", "browser.agent");
      const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "Use the add tool to add 17 and 25, then call finish with the result." }] }];
      let added = false;
      for (let turn = 0; turn < 4; turn++) {
        const response = await llm.chat.send({ choice, system: "You do tasks with the tools you have. Always use a tool.", tools, messages, maxTokens: 4000 });
        context.recordUsage(response.usage);
        messages.push({ role: "assistant", content: response.content });
        const uses = toolUses(response.content);
        if (uses.length === 0) return fail(`answered without a tool: ${JSON.stringify(response.content).slice(0, 120)}`);
        const results = [];
        for (const use of uses) {
          if (use.name === "finish") {
            const answer = (use.input as { answer?: unknown })?.answer;
            return added && String(answer).includes("42") ? pass(`${turn + 1} turns`) : fail(`finished with ${JSON.stringify(use.input)}${added ? "" : " before adding"}`);
          }
          const input = z.object({ a: z.number(), b: z.number() }).safeParse(use.input);
          if (use.name !== "add" || !input.success) {
            results.push(toolResult(use.id, `Invalid call: ${JSON.stringify(use.input)}`, true));
            continue;
          }
          added = true;
          results.push(toolResult(use.id, String(input.data.a + input.data.b)));
        }
        messages.push({ role: "user", content: results });
      }
      return fail("didn't finish in 4 turns");
    },
  },
];

/** A made-up warranty card, rendered to a PNG (what a phone photo of one shows, without the blur). */
async function warrantyCard(): Promise<Buffer> {
  warrantyPng ??= (async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 720, height: 460 } });
      await page.setContent(`<body style="font-family:Arial;padding:28px;background:#fdfbf4">
        <h1 style="margin:0 0 6px">WARRANTY CARD</h1><div style="color:#555">Example Appliances Ltd. · Service line 0800 000 000</div>
        <table style="margin-top:22px;font-size:20px;border-collapse:collapse">
        <tr><td style="padding:6px 18px 6px 0">Product</td><td><b>Washing machine WM-8 Eco</b></td></tr>
        <tr><td style="padding:6px 18px 6px 0">Serial no.</td><td>WM8-2025-118734</td></tr>
        <tr><td style="padding:6px 18px 6px 0">Date of purchase</td><td>14.03.2025</td></tr>
        <tr><td style="padding:6px 18px 6px 0">Warranty period</td><td>24 months</td></tr>
        <tr><td style="padding:6px 18px 6px 0">Warranty valid until</td><td><b>14.03.2027</b></td></tr>
        <tr><td style="padding:6px 18px 6px 0">Seller</td><td>Example Home Store, Main Street 1</td></tr></table></body>`);
      return await page.screenshot({ type: "png" });
    } finally {
      await browser.close();
    }
  })();
  return warrantyPng;
}
let warrantyPng: Promise<Buffer> | undefined;

interface Row {
  task: string;
  what: string;
  passed: number;
  runs: number;
  seconds: number[];
  usage: LlmUsage;
  failures: string[];
}

async function main(): Promise<void> {
  const only = args.only?.split(",").map((s) => s.trim());
  const checks = only ? CHECKS.filter((c) => only.includes(c.task)) : CHECKS;
  if (checks.length === 0) throw new Error(`No check named ${args.only}; there are ${CHECKS.map((c) => c.task).join(", ")}`);
  console.log(`llm:check ${MODEL}, ${RUNS} run(s) of ${checks.length} check(s)\n`);

  const rows: Row[] = [];
  for (const check of checks) {
    const row: Row = { task: check.task, what: check.what, passed: 0, runs: RUNS, seconds: [], usage: emptyUsage(), failures: [] };
    for (let run = 1; run <= RUNS; run++) {
      const context: StepContext = {
        runId: "check",
        userId: "check",
        pipelineId: "check",
        stepId: "check",
        stepKey: "check",
        itemIndex: null,
        dryRun: true,
        recordUsage: (more) => (row.usage = addUsage(row.usage, more)),
        attention: NO_ATTENTION,
      };
      const started = performance.now();
      let outcome: Outcome;
      try {
        outcome = await check.run(context);
      } catch (error) {
        outcome = fail(error instanceof Error ? error.message : String(error));
      }
      const seconds = (performance.now() - started) / 1000;
      row.seconds.push(seconds);
      if (outcome.ok) row.passed++;
      else row.failures.push(outcome.detail);
      console.log(`  ${outcome.ok ? "✓" : "✗"} ${check.task} #${run} ${seconds.toFixed(1)}s ${outcome.detail}`.trimEnd());
    }
    rows.push(row);
  }

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`\n| Task | Passed | Median time | Tokens in/out per run |\n| --- | --- | --- | --- |`);
  for (const row of rows) {
    console.log(
      `| ${row.task} | ${row.passed}/${row.runs} | ${median(row.seconds).toFixed(1)} s | ${Math.round(row.usage.inputTokens / row.runs)}/${Math.round(row.usage.outputTokens / row.runs)} |`,
    );
  }
  const total = rows.reduce((sum, r) => addUsage(sum, r.usage), emptyUsage());
  const passed = rows.reduce((sum, r) => sum + r.passed, 0);
  console.log(`\n${passed}/${rows.length * RUNS} passed; cost $${total.costUsd.toFixed(4)}`);

  const dir = resolve(__dirname, "results");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${new Date().toISOString().slice(0, 10)}-llm-check-${MODEL.replace(/[^a-z0-9.-]+/gi, "_")}.json`);
  writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), model: MODEL, runs: RUNS, rows }, null, 2));
  console.log(`Results: ${file}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
