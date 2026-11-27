import { type PrismaClient } from "@realentity/storm-db";
import { type LlmClient, type ModelRouter } from "@realentity/storm-llm";
import { type EmailMessage } from "@realentity/storm-steps";
import { z } from "zod";
import { type StepLearning } from "../learning/learning";
import { type StepContext } from "../runner/step-executor";
import { emailBlock } from "./email-block";
import { jobAppOf, jobItem, moveJob, type JobApp } from "./job-entities";
import { DATA_ONLY, LlmStep } from "./llm-steps";

/** Applications an email may be about: submitted and not turned down yet, the most recent first. */
const MAX_CANDIDATES = 30;
/** Addresses anyone has: a recruiter writing from one says nothing about the company. */
const PERSONAL_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail|abv|mail|dir|gmx|yandex)\./;

/** What an email is matched against: a Job's page and company. */
interface Candidate {
  url: string;
  company: string | null;
}

const OutcomeSchema = z.object({
  applicationId: z.string().nullable().describe("the application the email is about; null when none fits"),
  outcome: z.enum(["responded", "interview", "rejected", "none"]),
  reason: z.string().describe("one sentence"),
});

/** The outcome as the step tells it ({{outcome.status}}). */
const STATUS = { responded: "RESPONDED", interview: "INTERVIEW", rejected: "REJECTED" } as const;

const SYSTEM =
  "You read an email the user received and decide whether it is about one of their job applications (in " +
  "<applications>), and what it says: interview (they invite the user to an interview or a call, or schedule one), " +
  "rejected (they won't go on with the user), responded (a person from the employer or its recruiter answered " +
  "otherwise: a question, next steps, an assignment), none (not about these applications, or only an automatic " +
  "confirmation that the user's application arrived). " +
  `Pick the application by company and role; null with none when unsure. ${DATA_ONLY} The email is in <email>.`;

/**
 * application.outcome (M16-T3, on Apps since M33): what an email says about one of the Jobs the user applied to in the
 * pipeline's App, and the Job moved on: responded, interview, rejected. Only forward, as the type's stages allow; the
 * date of each stage kept, the email noted. Candidates are the open applications, those the sender's domain or the
 * company name points to first; without open applications no LLM is asked. A dry run moves nothing.
 */
export class ApplicationOutcomeStep extends LlmStep {
  readonly type = "application.outcome";

  constructor(
    private readonly prisma: PrismaClient,
    llm: LlmClient,
    router: ModelRouter,
    learning?: StepLearning,
  ) {
    super(llm, router, learning);
  }

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const message = input.message as EmailMessage;
    const jobApp = await jobAppOf(this.prisma, context);
    if (!jobApp) return unmatched("Its pipeline's App has no Job type to match the email against");
    return this.onJobs(jobApp, message, context);
  }

  /** The Jobs of the pipeline's App: a Job the user applied to moves forward as its stages allow. */
  private async onJobs(app: JobApp, message: EmailMessage, context: StepContext): Promise<unknown> {
    const rows = await this.prisma.dataEntity.findMany({ where: { appId: app.appId, type: "Job", removedAt: null, stage: { in: ["applied", "responded", "interview"] } } });
    const applied = (e: (typeof rows)[number]) => (e.stageDates as Record<string, string>).applied ?? "";
    const open = rows.sort((a, b) => applied(b).localeCompare(applied(a))).slice(0, MAX_CANDIDATES);
    if (open.length === 0) return unmatched("No submitted application is waiting for an answer");
    const asCandidate = (e: (typeof rows)[number]) => {
      const item = jobItem(app, e);
      return { entity: e, item, posting: { url: e.key, company: typeof item.company === "string" ? item.company : null } };
    };
    const all = open.map(asCandidate);
    const pointed = all.filter((c) => pointsTo(message, c.posting));
    const candidates = pointed.length ? pointed : all;
    const listed = candidates.map((c) =>
      JSON.stringify({ id: c.entity.dataEntityId, title: c.item.title, company: c.item.company, site: hostOf(c.entity.key), status: c.entity.stage }),
    );
    const answer = await this.call(context, SYSTEM, `<applications>\n${listed.join("\n")}\n</applications>\n${emailBlock(message)}`, OutcomeSchema);
    const found = candidates.find((c) => c.entity.dataEntityId === answer.applicationId);
    if (!found || answer.outcome === "none") return unmatched(answer.reason);
    const note = `${new Date().toISOString().slice(0, 10)} ${answer.outcome}: "${message.subject}" from ${message.from}`;
    const changed = await moveJob(this.prisma, context, app, found.entity, answer.outcome, note);
    const job = { title: found.item.title, company: found.item.company ?? null, url: found.entity.key };
    return { matched: true, applicationId: found.entity.dataEntityId, job, status: STATUS[answer.outcome], changed, reason: answer.reason };
  }
}

function unmatched(reason: string) {
  return { matched: false, applicationId: null, job: null, status: null, changed: false, reason };
}

/** The sender's own domain is the posting's site's, or the email names the company. */
function pointsTo(message: EmailMessage, candidate: Candidate): boolean {
  const domain = message.from.split("@")[1]?.toLowerCase() ?? "";
  const site = hostOf(candidate.url);
  const base = domain.split(".").slice(-2).join(".");
  if (domain && !PERSONAL_MAIL.test(domain) && site.endsWith(base)) return true;
  const company = (candidate.company ?? "").trim().toLowerCase();
  if (company.length < 3) return false;
  const text = `${message.fromName ?? ""} ${message.from} ${message.subject} ${message.text.slice(0, 5000)}`.toLowerCase();
  return text.includes(company) || (!PERSONAL_MAIL.test(domain) && domain.includes(company.split(/\s+/)[0]));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
