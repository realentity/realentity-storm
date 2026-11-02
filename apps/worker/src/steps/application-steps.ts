import { type Application, type JobPosting, type PrismaClient } from "@ai-me/db";
import { type LlmClient, type ModelRouter } from "@ai-me/llm";
import { movesForward, OUTCOME_DATE } from "@ai-me/shared";
import { type EmailMessage } from "@ai-me/steps";
import { z } from "zod";
import { type StepLearning } from "../learning/learning";
import { type StepContext } from "../runner/step-executor";
import { emailBlock } from "./email-block";
import { DATA_ONLY, LlmStep } from "./llm-steps";

/** Applications an email may be about: submitted and not turned down yet, the most recent first. */
const MAX_CANDIDATES = 30;
/** Addresses anyone has: a recruiter writing from one says nothing about the company. */
const PERSONAL_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail|abv|mail|dir|gmx|yandex)\./;

type Candidate = Application & { jobPosting: JobPosting };

const OutcomeSchema = z.object({
  applicationId: z.string().nullable().describe("the application the email is about; null when none fits"),
  outcome: z.enum(["responded", "interview", "rejected", "none"]),
  reason: z.string().describe("one sentence"),
});

const STATUS = { responded: "RESPONDED", interview: "INTERVIEW", rejected: "REJECTED" } as const;

const SYSTEM =
  "You read an email I received and decide whether it is about one of my job applications (in <applications>), and " +
  "what it says: interview (they invite me to an interview or a call, or schedule one), rejected (they won't go on " +
  "with me), responded (a person from the employer or its recruiter answered otherwise: a question, next steps, an " +
  "assignment), none (not about these applications, or only an automatic confirmation that my application arrived). " +
  `Pick the application by company and role; null with none when unsure. ${DATA_ONLY} The email is in <email>.`;

/**
 * application.outcome (M16-T3): what an email says about one of my applications, and the application moved on:
 * replied, interview, rejected. Only forward (a rejected one stays rejected; by hand on the Jobs page, anything), the
 * date of each outcome kept, the email noted, and application.status emitted (it cancels a follow-up waiting with
 * flow.later). Candidates are my open applications, those the sender's domain or the company name points to first;
 * without open applications no LLM is asked. A dry run moves nothing.
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
    const open = await this.prisma.application.findMany({
      where: { userId: context.userId, status: { in: ["SUBMITTED", "RESPONDED", "INTERVIEW"] } },
      include: { jobPosting: true },
      orderBy: { submittedAt: { sort: "desc", nulls: "last" } },
      take: MAX_CANDIDATES,
    });
    if (open.length === 0) return unmatched("No submitted application is waiting for an answer");
    const pointed = open.filter((candidate) => pointsTo(message, candidate));
    const candidates = pointed.length ? pointed : open;

    const listed = candidates.map((c) => JSON.stringify({ id: c.applicationId, title: c.jobPosting.title, company: c.jobPosting.company, site: hostOf(c.jobPosting.url), status: c.status }));
    const answer = await this.call(context, SYSTEM, `<applications>\n${listed.join("\n")}\n</applications>\n${emailBlock(message)}`, OutcomeSchema);
    const application = candidates.find((c) => c.applicationId === answer.applicationId);
    if (!application || answer.outcome === "none") return unmatched(answer.reason);

    const status = STATUS[answer.outcome];
    const job = { title: application.jobPosting.title, company: application.jobPosting.company, url: application.jobPosting.url };
    const changed = movesForward(application.status, status);
    if (changed && !context.dryRun) {
      const note = `${new Date().toISOString().slice(0, 10)} ${answer.outcome}: "${message.subject}" from ${message.from}`;
      await this.prisma.application.update({
        where: { applicationId: application.applicationId },
        data: {
          status,
          ...(application[OUTCOME_DATE[status]] ? {} : { [OUTCOME_DATE[status]]: new Date() }),
          notes: application.notes ? `${application.notes}\n${note}` : note,
        },
      });
      await context.emit?.("application.status", { applicationId: application.applicationId, status, job: { ...job, location: application.jobPosting.location } });
    }
    return { matched: true, applicationId: application.applicationId, job, status, changed, reason: answer.reason };
  }
}

function unmatched(reason: string) {
  return { matched: false, applicationId: null, job: null, status: null, changed: false, reason };
}

/** The sender's own domain is the posting's site's, or the email names the company. */
function pointsTo(message: EmailMessage, candidate: Candidate): boolean {
  const domain = message.from.split("@")[1]?.toLowerCase() ?? "";
  const site = hostOf(candidate.jobPosting.url);
  const base = domain.split(".").slice(-2).join(".");
  if (domain && !PERSONAL_MAIL.test(domain) && site.endsWith(base)) return true;
  const company = (candidate.jobPosting.company ?? "").trim().toLowerCase();
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
