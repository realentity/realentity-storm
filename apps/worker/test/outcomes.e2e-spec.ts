import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type StructuredRequest } from "@realentity/storm-llm";
import { defaultCatalog, type EmailMessage } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { type z } from "zod";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { ApplicationOutcomeStep } from "../src/steps/application-steps";
import { ScoreStep } from "../src/steps/llm-steps";

/** Answers what it's told to; keeps the prompts. */
class Scripted implements LlmClient {
  prompts: string[] = [];
  answer: (prompt: string) => unknown = () => ({});
  structured<S extends z.ZodObject>(request: StructuredRequest<S>) {
    this.prompts.push(request.prompt);
    return Promise.resolve({ output: request.schema.parse(this.answer(request.prompt)), usage: { ...emptyUsage(), calls: 1, costUsd: 0.001 } });
  }
}

const email = (from: string, subject: string, text: string): EmailMessage => ({
  uid: 1,
  messageId: `<${subject}@mail.test>`,
  threadId: `<${subject}@mail.test>`,
  inReplyTo: null,
  references: [],
  from,
  fromName: null,
  replyTo: from,
  to: ["ana@storm.test"],
  cc: [],
  subject,
  date: new Date().toISOString(),
  text,
  attachments: [],
});

// M16: outcomes of my applications, from emails (M16-T3), and in the scoring (M16-T2).
describe("M16: outcomes", () => {
  let db: PrismaConnection;
  let userId: string;
  let llm: Scripted;
  let emitted: { event: string; data: Record<string, unknown> }[];
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    llm = new Scripted();
    emitted = [];
    const submittedAt = new Date(Date.now() - 30 * 86_400_000);
    for (const [key, company, title, score] of [
      ["acme", "Acme", "Principal Engineer", 85],
      ["globex", "Globex", "Solutions Architect", 70],
      ["initech", "Initech", "Senior Developer", 40],
    ] as const) {
      const posting = await db.client.jobPosting.create({
        data: { userId, source: "dev.bg/search", url: `https://dev.bg/company/jobads/${key}/`, title, company, score, status: "APPLIED" },
      });
      ids[key] = (await db.client.application.create({ data: { userId, jobPostingId: posting.jobPostingId, status: "SUBMITTED", submittedAt } })).applicationId;
    }
  });

  afterEach(async () => {
    await db.client.jobPosting.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const context = (dryRun = false): StepContext => ({
    runId: "00000000-0000-4000-8000-000000000001",
    userId,
    pipelineId: "00000000-0000-4000-8000-000000000002",
    stepId: "s",
    stepKey: "outcome",
    itemIndex: 0,
    dryRun,
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
    emit: (event, data) => Promise.resolve(void emitted.push({ event, data })),
  });
  const step = () => new ApplicationOutcomeStep(db.client, llm, new ModelRouter(() => Promise.resolve(null)));
  const outcome = (message: EmailMessage, dryRun = false) =>
    step().execute(defaultCatalog().get("application.outcome")!.input.parse({ message }), context(dryRun)) as Promise<Record<string, unknown>>;
  const application = (key: string) => db.client.application.findUniqueOrThrow({ where: { applicationId: ids[key] } });

  it("an interview, then a rejection: the status moves on, both dates kept, the email noted, application.status emitted", async () => {
    llm.answer = () => ({ applicationId: ids.acme, outcome: "interview", reason: "They invite me to a call on Thursday." });
    const invite = await outcome(email("maria@acme.test", "Interview: Principal Engineer", "Hi Ana, could we talk on Thursday at 10?"));
    expect(invite).toMatchObject({ matched: true, applicationId: ids.acme, status: "INTERVIEW", changed: true, job: { company: "Acme", title: "Principal Engineer" } });
    // The sender's company points to one application: only it is offered to the model.
    expect(llm.prompts[0]).toContain('"company":"Acme"');
    expect(llm.prompts[0]).not.toContain("Globex");
    expect(await application("acme")).toMatchObject({ status: "INTERVIEW", interviewAt: expect.any(Date) as unknown, rejectedAt: null });
    expect((await application("acme")).notes).toMatch(/^\d{4}-\d\d-\d\d interview: "Interview: Principal Engineer" from maria@acme\.test$/);
    expect(emitted).toEqual([{ event: "application.status", data: expect.objectContaining({ applicationId: ids.acme, status: "INTERVIEW" }) as unknown }]);

    llm.answer = () => ({ applicationId: ids.acme, outcome: "rejected", reason: "They went with another candidate." });
    await outcome(email("maria@acme.test", "Your application at Acme", "Unfortunately we decided to move on with another candidate."));
    expect(await application("acme")).toMatchObject({ status: "REJECTED", interviewAt: expect.any(Date) as unknown, rejectedAt: expect.any(Date) as unknown });

    // Never backwards: a rejected application isn't open any more, so a late reply isn't matched to it.
    llm.answer = () => ({ applicationId: ids.acme, outcome: "responded", reason: "A reply." });
    expect(await outcome(email("maria@acme.test", "Re: Interview", "Thanks!"))).toMatchObject({ matched: false, changed: false });
    expect(await application("acme")).toMatchObject({ status: "REJECTED" });
    expect(emitted).toHaveLength(2);
  });

  it("an email that isn't about an application, an id it wasn't offered, a dry run, and no open applications", async () => {
    llm.answer = () => ({ applicationId: null, outcome: "none", reason: "An automatic confirmation." });
    expect(await outcome(email("noreply@globex.test", "We received your application", "Thank you for applying to Globex."))).toMatchObject({ matched: false, changed: false });

    llm.answer = () => ({ applicationId: "00000000-0000-4000-8000-0000000000aa", outcome: "interview", reason: "?" });
    expect(await outcome(email("hr@globex.test", "Interview", "Globex would like to meet you."))).toMatchObject({ matched: false });

    llm.answer = () => ({ applicationId: ids.globex, outcome: "interview", reason: "An invitation." });
    expect(await outcome(email("hr@globex.test", "Interview", "Globex would like to meet you."), true)).toMatchObject({ matched: true, status: "INTERVIEW", changed: true });
    // A step earlier in the funnel than the status (an interview, then a "replied"): no move.
    await db.client.application.update({ where: { applicationId: ids.initech }, data: { status: "INTERVIEW", interviewAt: new Date() } });
    llm.answer = () => ({ applicationId: ids.initech, outcome: "responded", reason: "A reply." });
    expect(await outcome(email("hr@initech.test", "Re: Initech", "Initech: see you then."))).toMatchObject({ matched: true, status: "RESPONDED", changed: false });
    expect(await application("initech")).toMatchObject({ status: "INTERVIEW", respondedAt: null });
    expect(await application("globex")).toMatchObject({ status: "SUBMITTED", interviewAt: null });
    expect(emitted).toEqual([]);

    await db.client.application.updateMany({ data: { status: "REJECTED" } });
    const calls = llm.prompts.length;
    expect(await outcome(email("hr@globex.test", "Interview", "Globex would like to meet you."))).toMatchObject({ matched: false, reason: "No submitted application is waiting for an answer" });
    expect(llm.prompts).toHaveLength(calls);
  });

  it("M16-T2: llm.score with outcomes gets my applications and what came of them; without, nothing", async () => {
    await db.client.application.update({ where: { applicationId: ids.acme }, data: { status: "REJECTED", interviewAt: new Date(), rejectedAt: new Date() } });
    await db.client.application.update({ where: { applicationId: ids.globex }, data: { status: "REJECTED", rejectedAt: new Date() } });
    llm.answer = (prompt) => ({ results: [...prompt.matchAll(/"index":(\d+)/g)].map((m) => ({ index: Number(m[1]), score: 50, reason: "ok" })) });
    const score = new ScoreStep(llm, new ModelRouter(() => Promise.resolve(null)), undefined, db.client);
    const input = (outcomes: boolean) =>
      defaultCatalog().get("llm.score")!.input.parse({ items: [{ title: "Staff Engineer", company: "Hooli" }], against: "Staff roles", outcomes });

    await score.execute(input(true), context());
    const block = /<outcomes>\n([\s\S]*?)\n<\/outcomes>/.exec(llm.prompts[0])?.[1] ?? "";
    const lines = block.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual(
      expect.arrayContaining([
        // An interview that ended in a rejection still got an interview.
        { title: "Principal Engineer", company: "Acme", location: null, scoredThen: 85, outcome: "interview" },
        { title: "Solutions Architect", company: "Globex", location: null, scoredThen: 70, outcome: "rejected" },
        { title: "Senior Developer", company: "Initech", location: null, scoredThen: 40, outcome: "no answer in 21 days" },
      ]),
    );
    await score.execute(input(false), context());
    expect(llm.prompts[1]).not.toContain("<outcomes>");
  });
});
