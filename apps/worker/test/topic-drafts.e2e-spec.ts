import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type LlmUsage, type StructuredRequest } from "@realentity/storm-llm";
import { EmailMessageSchema, PipelineCompiler, type EmailMessage, type StepDefinition } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry, NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { DraftReplyStep } from "../src/steps/email-steps";
import { DraftFollowUpStep } from "../src/steps/follow-up-steps";
import { catalog as testCatalog, Counting, createVersion } from "./support/test-steps";

/** The writing model: a fixed body, and the facts it says it used. */
class DraftLlm implements LlmClient {
  requests: StructuredRequest<z.ZodObject>[] = [];
  constructor(private readonly used: string[] = []) {}
  structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<{ output: z.infer<S>; usage: LlmUsage }> {
    this.requests.push(request);
    const answer = {
      body: "Hi Maria, the launch is in March.",
      language: "en",
      ...("used" in request.schema.shape ? { used: this.used } : {}),
    };
    return Promise.resolve({ output: request.schema.parse(answer), usage: emptyUsage() });
  }
}

const router = new ModelRouter(() => Promise.resolve(null));
let n = 0;
const email = (extra: Partial<EmailMessage> = {}): EmailMessage => {
  const id = `<d${++n}@client.example>`;
  return {
    uid: n,
    messageId: id,
    threadId: id,
    inReplyTo: null,
    references: [],
    from: "maria@client.example",
    fromName: "Maria",
    replyTo: "maria@client.example",
    to: ["me@storm.test"],
    cc: [],
    subject: "When do we launch?",
    date: "2026-11-20T09:00:00.000Z",
    text: "When is the launch?",
    attachments: [],
    ...extra,
  };
};

// M42-T3: drafts that use what the user's approved memory of the topic says is true now
describe("drafting with a topic", () => {
  let db: PrismaConnection;
  let userId: string;
  let orion: string;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    orion = (await db.client.topic.create({ data: { userId, name: "Orion", description: "The customer portal rebuild" } })).topicId;
    const fact = (statement: string, date: string, status: "CURRENT" | "SUPERSEDED") =>
      db.client.topicFact.create({
        data: {
          userId,
          topicId: orion,
          about: "Launch date",
          statement,
          source: "EMAIL",
          sourceId: `<${statement}@client.example>`,
          sourceLabel: "maria@client.example: Plan",
          sourceDate: new Date(date),
          status,
        },
      });
    await fact("February", "2026-11-01T09:00:00Z", "SUPERSEDED");
    await fact("March", "2026-11-12T09:00:00Z", "CURRENT");
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.topic.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const link = (message: EmailMessage, status: "LINKED" | "SUGGESTED" | "CONFIRMED" = "LINKED", messageId = message.messageId) =>
    db.client.topicLink.create({
      data: {
        userId,
        topicId: orion,
        messageId,
        threadId: message.threadId,
        from: message.from,
        subject: message.subject,
        date: new Date(message.date),
        status,
        via: status === "SUGGESTED" ? "LLM" : "DIRECTION",
        evidence: "client.example",
      },
    });
  const context = (): StepContext => ({
    runId: randomUUID(),
    userId,
    pipelineId: randomUUID(),
    stepId: "draft",
    stepKey: "draft",
    itemIndex: null,
    dryRun: false,
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
  });
  const reply = (llm: LlmClient, message: EmailMessage, topic?: string) =>
    new DraftReplyStep(llm, router, undefined, undefined, db.client).execute(
      { message, instruction: "Answer the question.", ...(topic ? { topic } : {}) },
      context(),
    ) as Promise<{ body: string; drewOn: string[] }>;

  // M42-V1 (with a stand-in model)
  it("auto: a linked email's reply gets the current facts, not the superseded ones, and says what it used", async () => {
    const question = email();
    await link(question);
    const llm = new DraftLlm(["F1"]);
    const draft = await reply(llm, question);
    const memory = llm.requests[0]?.cachedPrompt ?? "";
    expect(memory).toContain('<topic name="Orion">');
    expect(memory).toContain("F1: Launch date: March (maria@client.example: Plan, 2026-11-12)");
    expect(memory).not.toContain("February");
    expect(llm.requests[0]?.system).toContain("<memory> is what the user's own approved memory");
    // The placeholder rule stays.
    expect(llm.requests[0]?.system).toContain("write a placeholder");
    expect(draft.drewOn).toEqual(["Orion: Launch date: March (maria@client.example: Plan)"]);
  });

  it("auto uses no topic waiting for the user; none uses none; a topic by name; an unknown name fails", async () => {
    const maybe = email();
    await link(maybe, "SUGGESTED");
    const llm = new DraftLlm();
    expect((await reply(llm, maybe)).drewOn).toEqual([]);
    expect(llm.requests[0]?.cachedPrompt).toBeUndefined();
    expect(llm.requests[0]?.system).not.toContain("<memory> is what");

    const linked = email();
    await link(linked);
    expect((await reply(llm, linked, "none")).drewOn).toEqual([]);
    expect(llm.requests[1]?.cachedPrompt).toBeUndefined();

    // Named: used even without a link; the model used no fact.
    expect((await reply(llm, email(), "orion")).drewOn).toEqual(["Orion: no fact it knows was needed"]);
    await expect(reply(llm, email(), "Secret plans")).rejects.toThrow('No topic named "Secret plans"');
  });

  it("a follow-up of the user's own email uses its thread's topics", async () => {
    const theirs = email();
    await link(theirs);
    const mine = email({ from: "me@storm.test", fromName: null, threadId: theirs.threadId, subject: "Re: When do we launch?" });
    const llm = new DraftLlm(["F1"]);
    const draft = (await new DraftFollowUpStep(llm, router, undefined, undefined, db.client).execute(
      { message: mine, instruction: "A short nudge." },
      context(),
    )) as { drewOn: string[] };
    expect(llm.requests[0]?.cachedPrompt).toContain("Launch date: March");
    expect(draft.drewOn).toEqual(["Orion: Launch date: March (maria@client.example: Plan)"]);
  });

  it("the gate shows what the draft drew on", async () => {
    const question = email();
    await link(question);
    const INBOX: StepDefinition = {
      type: "test.inbox",
      description: "the emails of a test",
      sideEffect: false,
      saasSafe: true,
      input: z.object({}),
      output: z.object({ messages: z.array(EmailMessageSchema) }),
    };
    const catalog = testCatalog.with(INBOX);
    const runner = new PipelineRunner(
      db.client,
      catalog,
      new ExecutorRegistry([
        new Counting("test.inbox", () => ({ messages: [question] })),
        new DraftReplyStep(new DraftLlm(["F1"]), router, undefined, undefined, db.client),
        new Counting("test.send", () => ({ messageId: "m-1" })),
      ]),
    );
    const source = `
name: Orion replies
steps:
  - id: inbox
    type: test.inbox
    with: {}
  - id: draft
    type: email.draftReply
    forEach: "{{inbox.messages}}"
    with: { message: "{{item}}", instruction: "Answer the question." }
  - id: send
    type: test.send
    forEach: "{{inbox.messages}}"
    with: { to: "{{item.from}}", body: "{{draft.body}}" }
`;
    const runId = await runner.start(await createVersion(db.client, userId, source, new PipelineCompiler(catalog)), { trigger: "manual" });
    await expect(runner.advance(runId)).resolves.toBe("WAITING_FOR_USER");
    const [proposal] = await db.client.proposal.findMany({ where: { runId } });
    expect(proposal?.reasoning).toBe("Drew on what Storm knows about the topic:\n• Orion: Launch date: March (maria@client.example: Plan)");
    expect((proposal?.originalPayload as Prisma.JsonObject).body).toBe("Hi Maria, the launch is in March.");
  });
});
