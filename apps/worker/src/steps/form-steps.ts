import { type Fact, type JobPosting, type PrismaClient } from "@ai-me/db";
import { type LlmClient, type ModelRouter } from "@ai-me/llm";
import { type FormField, type FormFile } from "@ai-me/steps";
import { type Locator, type Page } from "playwright";
import { z } from "zod";
import { type ArtifactOwner } from "../browser/artifact-store";
import { blockingState } from "../browser/blocking";
import { type DocumentStore } from "../browser/document-store";
import { findForm, NEXT, readForm, type PageField, type PageForm } from "../browser/form-reader";
import { type Asker } from "../learning/asker";
import { type Facts } from "../learning/facts";
import { type StepLearning } from "../learning/learning";
import { NO_ATTENTION, RunStopped, type Attention, type StepContext, type StepExecutor } from "../runner/step-executor";
import { jobAppOf, moveJob } from "./job-entities";
import { type BrowserDependencies } from "./browser-steps";
import { DATA_ONLY, LlmStep } from "./llm-steps";

/** A CV / résumé file field, by its label or key. */
const CV_FIELD = /\b(cv|resume|résumé|curriculum)\b|автобиография/i;
/** Wizard steps a form may have (each needs a Next). */
const MAX_PAGES = 10;
const MAX_CONFIRMATION = 2000;

export interface FormDependencies extends BrowserDependencies {
  documents: DocumentStore;
  /** My facts (M15): read before anything is written. */
  facts?: Facts;
  /** Asking me what neither my profile nor my facts answer (M15-T3). */
  asker?: Asker;
}

export type Answer = { value: string | null; source: FormField["source"]; fact?: FormField["fact"] };

interface MapInput {
  url: string;
  headed: boolean;
  cv?: string;
  message?: string;
  job?: Record<string, unknown>;
  timeoutSeconds: number;
}

/** The LLM's values, one per field it was given. */
const AnswersSchema = z.object({
  values: z.array(
    z.object({
      key: z.string(),
      value: z.string().nullable().describe('the text to type or the option to pick; checkbox: "yes" or "no"; null: leave empty'),
      source: z.enum(["profile", "fact", "written", "none"]),
      factId: z.string().nullish().describe("source fact: the id of the fact used"),
    }),
  ),
  notes: z.string().describe("fields left empty and why, in a sentence or two"),
});

const SYSTEM =
  "You fill in a job application form for me. For each field, give the value from <profile> (my facts: name, " +
  "contacts, location, work permit, notice period, salary, links), source profile; or, when a field asks what one of " +
  "<facts> answers (my earlier answers: the same question, maybe worded differently), that answer exactly, source " +
  "fact with its id (a choice field: the option that answer names); or, for a free-text question " +
  "(a message to the employer, why this role), write a short answer following <message> from my profile and the " +
  "posting only, source written; or null with source none when neither has it. Never invent a fact about me: no " +
  "experience, number, date, salary or claim my profile doesn't state; a question the profile doesn't answer stays " +
  "null. Selects and radios: one of the given options, exactly as written. Checkboxes: \"yes\" only for consent to " +
  `process my data for this application or terms the form requires; anything else (newsletters, marketing) "no". ${DATA_ONLY} ` +
  "The form's labels and the posting are in <form> and <posting>.";

/**
 * browser.mapForm (README §2.2, M10-T2): the form read, nothing typed or attached. Values come from my profile
 * (Settings) or are written for free-text questions; my CV document goes to the CV field. The output is the payload
 * of browser.fillAndSubmit, which I see field by field at its gate. An Application is prepared for the posting.
 */
export class MapFormStep extends LlmStep {
  readonly type = "browser.mapForm";

  constructor(
    private readonly deps: FormDependencies,
    llm: LlmClient,
    router: ModelRouter,
    learning?: StepLearning,
  ) {
    super(llm, router, learning);
  }

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { url, headed, cv, message, job, timeoutSeconds } = input as unknown as MapInput;
    const timeout = timeoutSeconds * 1000;
    const lease = await this.deps.pool.lease(headed, { acceptDownloads: false });
    const attention = lease.headed ? context.attention : NO_ATTENTION;
    try {
      const page = await lease.context.newPage();
      page.setDefaultTimeout(timeout);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await settle(page);
      await unblock(page, attention);
      const form = await findForm(page, () => settle(page));
      if (!form) throw new Error(`No application form on ${page.url()} (nor behind an Apply button)`);
      await attention.checkpoint(page.url());

      const profile = (await this.deps.prisma.userSetting.findUnique({ where: { userId: context.userId } }))?.profile ?? "";
      const facts = (await this.deps.facts?.list(context.userId)) ?? [];
      const answers = await this.propose(context, form, profile, message, job, facts);
      const fields: FormField[] = form.fields.map((field) => withValue(field, answers.values.get(field.key)));
      const asked = await this.askMe(context, fields, new URL(page.url()).hostname);
      await this.deps.facts?.used(fields.flatMap((f) => (f.source === "fact" && f.fact ? [f.fact.factId] : [])));
      const files: FormFile[] = [];
      const cvField = cvFieldOf(form.fields);
      if (cv && cvField) files.push(await this.deps.documents.attach(this.deps.prisma, context.userId, cv, cvField.key));
      const missing = fields.filter((f) => f.required && f.type !== "file" && !f.human && (f.value === null || f.value === "")).map((f) => f.label);
      const checks = fields.filter((f) => f.human).map((f) => `"${f.label}"`);
      const notes = [
        answers.notes,
        checks.length ? `A check that you're a person (${checks.join(", ")}): you answer it in the live view before it is sent.` : "",
        cv && !cvField ? "The form has no CV field." : "",
        asked.length ? `Asked you: ${asked.join(", ")}.` : "",
        missing.length ? `Required and still empty: ${missing.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");

      await this.screenshot(page, context).catch(() => undefined);
      if (!context.dryRun && typeof job?.url === "string") await prepareApplication(this.deps.prisma, context, job.url);
      return { formUrl: page.url(), fields, files, submit: form.submit, notes };
    } finally {
      await lease.close();
    }
  }

  /** The values for the form: one LLM call for every field that takes one (files aside); none without such fields. */
  async propose(
    context: StepContext,
    form: PageForm,
    profile: string,
    message: string | undefined,
    job: Record<string, unknown> | undefined,
    facts: Fact[] = [],
  ): Promise<{ values: Map<string, Answer>; notes: string }> {
    const fields = form.fields.filter((f) => f.type !== "file" && !f.human);
    const values = new Map<string, Answer>();
    if (fields.length === 0) return { values, notes: "" };
    const prompt = [
      `<profile>\n${profile || "(empty: I haven't written my profile yet)"}\n</profile>`,
      `<facts>\n${facts.map((f) => JSON.stringify({ id: f.factId, question: f.question, answer: f.answer })).join("\n") || "(none yet)"}\n</facts>`,
      `<message>${message ?? "A short, plain message: why this role fits me, from my profile, 2-3 sentences."}</message>`,
      `<posting>\n${JSON.stringify(job ?? {})}\n</posting>`,
      `<form>\n${fields.map((f) => JSON.stringify({ key: f.key, label: f.label, type: f.type, required: f.required, options: f.options })).join("\n")}\n</form>`,
    ].join("\n");
    const answer = await this.call(context, SYSTEM, prompt, AnswersSchema, true);
    const byId = new Map(facts.map((f) => [f.factId, f]));
    for (const v of answer.values) {
      if (!fields.some((f) => f.key === v.key)) continue;
      const fact = v.source === "fact" && v.factId ? byId.get(v.factId) : undefined;
      // A fact it names must be one of mine, with my answer: else nothing (the field is asked or left empty).
      if (v.source === "fact" && (!fact || !sameAnswer(v.value, fact.answer))) values.set(v.key, { value: null, source: "none" });
      else values.set(v.key, { value: v.value, source: v.source, ...(fact ? { fact: { factId: fact.factId, question: fact.question } } : {}) });
    }
    return { values, notes: answer.notes };
  }

  /**
   * Required fields still empty (not files, checkboxes or person checks): asked one by one; an answer (an option of
   * a choice field) fills the field. The labels of what was asked and answered.
   */
  private async askMe(context: StepContext, fields: FormField[], site: string): Promise<string[]> {
    if (!this.deps.asker) return [];
    const asked: string[] = [];
    for (const field of fields) {
      if (!field.required || field.human || field.type === "file" || field.type === "checkbox" || (field.value !== null && field.value !== "")) continue;
      const reply = await this.deps.asker.ask(context, { question: field.label || field.key, options: field.options, site });
      if (!reply) continue;
      const value = field.options?.length ? field.options.find((o) => o.trim().toLowerCase() === reply.answer.trim().toLowerCase()) : reply.answer;
      if (value === undefined) continue;
      Object.assign(field, { value, source: "asked", ...(reply.factId ? { fact: { factId: reply.factId, question: field.label } } : {}) });
      asked.push(field.label || field.key);
    }
    return asked;
  }

  private async screenshot(page: Page, context: StepContext): Promise<void> {
    const png = await page.screenshot({ fullPage: true, timeout: 10_000 });
    await this.deps.artifacts.save(this.deps.prisma, ownerOf(context), "screenshot", png, "png", "image/png");
  }
}

interface FillInput {
  url: string;
  fields: FormField[];
  files: FormFile[];
  stopBeforeSubmit: boolean;
  job?: string;
  timeoutSeconds: number;
}

/**
 * browser.fillAndSubmit (README §2.2, M10-T3/T4): the approved payload, exactly, in the live browser. Before typing,
 * the form is read again and compared with what I approved: a field gone, a new required field, a choice no longer
 * offered or another site pauses the run for me with nothing sent, and only a form that matches again goes on.
 * Files are the approved documents, checked by content. With stopBeforeSubmit I press the final button myself.
 */
export class FillAndSubmitStep implements StepExecutor {
  readonly type = "browser.fillAndSubmit";

  constructor(private readonly deps: FormDependencies) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { url, fields, files, stopBeforeSubmit, job, timeoutSeconds } = input as unknown as FillInput;
    const timeout = timeoutSeconds * 1000;
    const host = new URL(url).hostname;
    const lease = await this.deps.pool.lease(true, { acceptDownloads: false });
    const attention = lease.headed ? context.attention : NO_ATTENTION;
    let page: Page | undefined;
    try {
      page = await lease.context.newPage();
      page.setDefaultTimeout(timeout);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await settle(page);
      await unblock(page, attention);
      const current = page;
      let form = await findForm(current, () => settle(current));
      if (!form) throw new Error(`No application form on ${current.url()}: nothing was sent`);

      // The form must be the one I approved, on the site I approved.
      for (let attempt = 0; ; attempt++) {
        const problems = differences(current, host, form, fields, files);
        if (problems.length === 0) break;
        if (attempt > 0) throw new Error(`Nothing was sent: ${problems.join("; ")}`);
        await attention.needMe(`The form changed since I approved it (${problems.join("; ")}); nothing was sent`, current.url());
        form = await readForm(current);
      }

      const attachments = await Promise.all(files.map(async (f) => ({ ...f, file: await this.deps.documents.approvedFile(this.deps.prisma, context.userId, f) })));
      await fill(current, fields, attachments, attention);
      await this.screenshot(current, context).catch(() => undefined);

      const before = await bodyText(current);
      let submitted: boolean;
      if (stopBeforeSubmit) {
        await attention.needMe(`Filled as approved: check it and press "${form.submit || "Submit"}" yourself, then Continue`, current.url());
        submitted = await sent(current, fields, before);
      } else {
        // A check that I'm a person is mine to answer, as the page asks it now.
        const checks = (await readForm(current)).fields.filter((f) => f.human);
        if (checks.length > 0) {
          await attention.needMe(`Answer ${checks.map((f) => `"${f.label}"`).join(", ")} in the form yourself, then Continue: it is sent then`, current.url());
        } else {
          await attention.checkpoint(current.url());
        }
        await submitButton(current, form.submit).click();
        await settle(current, timeout);
        submitted = await sentWithin(current, fields, before, timeout);
        if (!submitted) {
          await attention.needMe("The site didn't take the form (see its messages); fix it and send it, or Abort", current.url());
          submitted = await sent(current, fields, before);
        }
      }
      if (submitted && !context.dryRun && job) await submitApplication(this.deps.prisma, context, job);
      const confirmation = (await current.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      await this.screenshot(current, context).catch(() => undefined);
      return { submitted, url: current.url(), confirmation: confirmation.slice(0, MAX_CONFIRMATION) };
    } catch (error) {
      if (page) await this.screenshot(page, context).catch(() => undefined);
      if (error instanceof RunStopped) throw error;
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      await lease.close();
    }
  }

  private async screenshot(page: Page, context: StepContext): Promise<void> {
    const png = await page.screenshot({ fullPage: true, timeout: 10_000 });
    await this.deps.artifacts.save(this.deps.prisma, ownerOf(context), "screenshot", png, "png", "image/png");
  }
}

/** What doesn't match between the form now and the approved payload (empty: it matches). */
export function differences(page: Page, host: string, form: PageForm, fields: FormField[], files: FormFile[]): string[] {
  const problems: string[] = [];
  if (new URL(page.url()).hostname !== host) problems.push(`the form is on ${new URL(page.url()).hostname}, not ${host}`);
  const onPage = new Map(form.fields.map((f) => [f.key, f]));
  const approved = new Set([...fields.map((f) => f.key), ...files.map((f) => f.key)]);
  for (const field of fields) {
    const now = onPage.get(field.key);
    if (!now) problems.push(`"${field.label}" is no longer on the form`);
    else if (now.type !== field.type) problems.push(`"${field.label}" is now a ${now.type} field`);
    else if ((field.type === "select" || field.type === "radio") && typeof field.value === "string" && !now.options?.includes(field.value)) {
      problems.push(`"${field.label}" no longer offers "${field.value}"`);
    }
  }
  for (const file of files) if (onPage.get(file.key)?.type !== "file") problems.push(`the file field for "${file.document}" is gone`);
  for (const field of form.fields) if (field.required && !approved.has(field.key)) problems.push(`"${field.label}" is new and required`);
  return problems;
}

/** Fills what is visible, then the wizard's Next, until every approved field is done or no Next is left. */
async function fill(page: Page, fields: FormField[], files: (FormFile & { file: { name: string; mimeType: string; buffer: Buffer } })[], attention: Attention): Promise<void> {
  const pending = new Map<string, () => Promise<void>>();
  for (const field of fields) {
    if (field.value === null || field.type === "file" || field.human) continue;
    pending.set(field.key, () => setValue(page, field));
  }
  for (const file of files) pending.set(file.key, () => page.locator(file.key).first().setInputFiles(file.file));

  for (let step = 0; step < MAX_PAGES && pending.size > 0; step++) {
    for (const [key, apply] of [...pending]) {
      const element = page.locator(key).first();
      const shown = (await element.isVisible().catch(() => false)) || (await element.getAttribute("type").catch(() => null)) === "file";
      if (!shown || !(await reachable(element))) continue;
      await attention.checkpoint(page.url());
      await apply();
      pending.delete(key);
    }
    if (pending.size === 0) break;
    const next = await visibleButton(page, NEXT);
    if (!next) break;
    await next.click();
    await settle(page);
  }
  if (pending.size > 0) throw new Error(`Couldn't reach ${[...pending.keys()].join(", ")} on the form: nothing was sent`);
  // On the last page: whatever the wizard needs to show the final button.
  const last = await visibleButton(page, NEXT);
  if (last && !(await submitVisible(page))) {
    await last.click();
    await settle(page);
  }
}

async function setValue(page: Page, field: FormField): Promise<void> {
  const element = page.locator(field.key);
  switch (field.type) {
    case "select":
      await element.first().selectOption({ label: String(field.value) });
      return;
    case "radio":
      await page.getByLabel(String(field.value), { exact: true }).and(element).check();
      return;
    case "checkbox":
      await element.first().setChecked(field.value === true);
      return;
    default:
      await element.first().fill(String(field.value));
  }
}

/** A file input may be hidden behind a styled button; any other field must be inside the visible step. */
async function reachable(element: Locator): Promise<boolean> {
  return element
    .evaluate((el: { closest(selector: string): unknown; disabled?: boolean }) => !el.closest("[hidden], [aria-hidden='true']") && !el.disabled)
    .catch(() => false);
}

async function visibleButton(page: Page, label: RegExp): Promise<Locator | null> {
  const buttons = page.locator('button, input[type="button"], a[role="button"]');
  const total = Math.min(await buttons.count(), 100);
  for (let i = 0; i < total; i++) {
    const button = buttons.nth(i);
    const text = (await button.innerText().catch(() => "")) || ((await button.getAttribute("value").catch(() => null)) ?? "");
    const type = (await button.getAttribute("type").catch(() => null)) ?? "";
    if (type === "submit" && !label.test(text)) continue;
    if (label.test(text) && (await button.isVisible().catch(() => false))) return button;
  }
  return null;
}

async function submitVisible(page: Page): Promise<boolean> {
  return page
    .locator('form button[type="submit"], form input[type="submit"], form button:not([type])')
    .last()
    .isVisible()
    .catch(() => false);
}

function submitButton(page: Page, label: string): Locator {
  const all = page.locator('form button[type="submit"], form input[type="submit"], form button:not([type])');
  return label ? all.filter({ hasText: label }).or(page.locator(`input[type="submit"][value="${label.replace(/"/g, '\\"')}"]`)).last() : all.last();
}

const THANKS = /thank you|thanks for|successfully|has been sent|was received|have received|благодарим|успешно|изпратен|получихме/gi;

/**
 * Whether the form went: a confirmation page (the approved fields are gone), or, where the site sends it without
 * leaving the page (Contact Form 7 and other AJAX forms), a new thank-you message, or the filled fields cleared,
 * with no field marked invalid.
 */
export async function sent(page: Page, fields: FormField[], before: string): Promise<boolean> {
  const keys = fields.map((f) => f.key);
  const counts = await Promise.all(keys.map((key) => page.locator(key).count().catch(() => 0)));
  if (counts.every((count) => count === 0)) return true;
  const invalid = await page.locator('[aria-invalid="true"], .wpcf7-not-valid').count().catch(() => 0);
  if (invalid > 0) return false;
  const after = await bodyText(page);
  if ((after.match(THANKS)?.length ?? 0) > (before.match(THANKS)?.length ?? 0)) return true;
  const typed = fields.filter((f) => typeof f.value === "string" && f.value !== "" && !["select", "radio", "checkbox", "file"].includes(f.type) && !f.human);
  if (typed.length === 0) return false;
  // Not the page's default timeout: a field the site removes meanwhile would hold this check (and sentWithin) that long.
  const values = await Promise.all(typed.map((f) => page.locator(f.key).first().inputValue({ timeout: 1_000 }).catch(() => null)));
  return values.every((value) => value === "");
}

/** An AJAX form answers a while after the click (the page was idle already, so no load state waits for it). */
export async function sentWithin(page: Page, fields: FormField[], before: string, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await sent(page, fields, before)) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(250);
  }
}

export async function bodyText(page: Page): Promise<string> {
  return (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
}

export function withValue(field: PageField, answer: Answer | undefined): FormField {
  if (field.type === "file" || field.human || !answer || answer.value === null || answer.value.trim() === "") return { ...field, value: null, source: "none" };
  const fact = answer.fact ? { fact: answer.fact } : {};
  if (field.type === "checkbox") return { ...field, value: /^(yes|true|1)$/i.test(answer.value.trim()), source: answer.source, ...fact };
  if ((field.type === "select" || field.type === "radio") && !field.options?.includes(answer.value)) return { ...field, value: null, source: "none" };
  return { ...field, value: answer.value, source: answer.source, ...fact };
}

/** A fact's answer as the LLM gave it: the same text, or (a choice field) an option naming it. */
function sameAnswer(value: string | null, answer: string): boolean {
  if (value === null) return false;
  const a = value.trim().toLowerCase();
  const b = answer.trim().toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

function cvFieldOf(fields: PageField[]): PageField | undefined {
  const files = fields.filter((f) => f.type === "file");
  return files.find((f) => CV_FIELD.test(f.label) || CV_FIELD.test(f.key)) ?? files.find((f) => f.required) ?? files[0];
}

/** M10-T5: the posting's Application, prepared (a submitted one stays submitted). M33: in an App, the Job moved. */
export async function prepareApplication(prisma: PrismaClient, context: StepContext, url: string): Promise<void> {
  const job = await jobAppOf(prisma, context);
  if (job) {
    const entity = await prisma.dataEntity.findUnique({ where: { appId_type_key: { appId: job.appId, type: "Job", key: url } } });
    if (entity) await moveJob(prisma, context, job, entity, "prepared");
    return;
  }
  const posting = await prisma.jobPosting.findFirst({ where: { userId: context.userId, url } });
  if (!posting) return;
  const existing = await prisma.application.findUnique({ where: { jobPostingId: posting.jobPostingId } });
  if (existing && existing.status !== "PREPARED") return;
  const application = await prisma.application.upsert({
    where: { jobPostingId: posting.jobPostingId },
    create: { userId: context.userId, jobPostingId: posting.jobPostingId, status: "PREPARED", runId: context.runId },
    update: { runId: context.runId },
  });
  if (!existing) await emitApplication(context, application.applicationId, "PREPARED", posting);
}

/** M10-T5: sent: the Application submitted, the posting applied. M33: in an App, the Job moved to applied. */
export async function submitApplication(prisma: PrismaClient, context: StepContext, url: string): Promise<void> {
  const job = await jobAppOf(prisma, context);
  if (job) {
    const entity = await prisma.dataEntity.findUnique({ where: { appId_type_key: { appId: job.appId, type: "Job", key: url } } });
    if (entity) await moveJob(prisma, context, job, entity, "applied");
    return;
  }
  const posting = await prisma.jobPosting.findFirst({ where: { userId: context.userId, url } });
  if (!posting) return;
  const now = new Date();
  const [application] = await prisma.$transaction([
    prisma.application.upsert({
      where: { jobPostingId: posting.jobPostingId },
      create: { userId: context.userId, jobPostingId: posting.jobPostingId, status: "SUBMITTED", submittedAt: now, runId: context.runId },
      update: { status: "SUBMITTED", submittedAt: now, runId: context.runId },
    }),
    prisma.jobPosting.update({ where: { jobPostingId: posting.jobPostingId }, data: { status: "APPLIED" } }),
  ]);
  await emitApplication(context, application.applicationId, "SUBMITTED", posting);
}

/** application.status (M12-T1), with the posting. */
async function emitApplication(context: StepContext, applicationId: string, status: string, posting: JobPosting): Promise<void> {
  await context.emit?.("application.status", {
    applicationId,
    status,
    job: { title: posting.title, company: posting.company, location: posting.location, url: posting.url },
  });
}

export function ownerOf(context: StepContext): ArtifactOwner {
  return { userId: context.userId, runId: context.runId, stepKey: context.stepKey, itemIndex: context.itemIndex };
}

export async function unblock(page: Page, attention: Attention): Promise<void> {
  const reason = await blockingState(page);
  if (!reason) return;
  await attention.needMe(reason, page.url());
  await settle(page);
  if (await blockingState(page)) throw new Error("The page is still blocked after taking over");
}

export async function settle(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 3_000) }).catch(() => undefined);
}
