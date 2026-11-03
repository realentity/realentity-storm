import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { type BuilderChatView, type BuilderDryRunResponse, type PipelineDetailView } from "@ai-me/shared";
import { TestEnvironment } from "@ai-me/testing";
import type request from "supertest";
import { MAX_CALLS_PER_TURN } from "../src/builder/builder";
import { callTools, propose, say, ScriptedChat, toolResults, userText } from "./support/scripted-chat";
import { createTestApp, type TestApp } from "./support/test-app";

/** The M4 pipeline, as the builder would propose it: no gate before email.send (the compiler adds it). */
const replies = (instruction = "Reply briefly and warmly as me.", mailbox = "INBOX") => ({
  name: "Recruiter replies",
  trigger: { schedule: "*/15 * * * *", tz: "Europe/Sofia" },
  steps: [
    { id: "fetch", type: "email.fetch", with: { mailbox } },
    { id: "triage", type: "email.classify", with: { messages: "{{fetch.messages}}", instruction: "reply: recruiters writing to me" } },
    { id: "draft", type: "email.draftReply", forEach: "{{triage.kept}}", with: { message: "{{item}}", instruction } },
    {
      id: "send",
      type: "email.send",
      forEach: "{{triage.kept}}",
      with: { to: "{{item.from}}", subject: "{{draft.subject}}", body: "{{draft.body}}", inReplyTo: "{{item.messageId}}" },
    },
  ],
  limits: { "email.send": "20/day" },
});

// M7: the builder chat (README §2.1, §2.5), with a scripted model
describe("builder chat", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let userId: string;
  const llm = new ScriptedChat();

  beforeAll(async () => {
    api = await createTestApp({ builderLlm: llm });
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  afterEach(async () => {
    llm.reset();
    await db.client.builderChat.deleteMany();
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const newChat = async (pipelineId?: string) =>
    (await agent.post("/api/builder/chats").send({ pipelineId }).expect(201)).body as BuilderChatView;
  const send = async (chatId: string, text: string, suggestionId?: string) =>
    (await agent.post(`/api/builder/chats/${chatId}/messages`).send({ text, suggestionId }).expect(200)).body as BuilderChatView;
  const lastProposal = (chat: BuilderChatView) => chat.messages.filter((m) => m.proposal).at(-1)!;
  const createPipeline = async (definition: unknown) =>
    (
      await agent
        .post("/api/pipelines")
        .send({ source: JSON.stringify(definition) })
        .expect(201)
    ).body as PipelineDetailView;

  it("M7-U1: a proposal that doesn't compile goes back to the builder; what it fixes is shown with plan and policy", async () => {
    const broken = { ...replies(), steps: [{ id: "fetch", type: "email.fetch", with: { folder: "INBOX" } }] };
    llm.answer(propose(broken), propose(replies()), say("Every 15 minutes it drafts replies to recruiters."));
    const chat = await newChat();
    const answered = await send(chat.chatId, "Draft replies to recruiters every 15 minutes.");

    const [sentBack] = toolResults(llm.requests[1]);
    expect(sentBack).toMatchObject({ is_error: true });
    expect(sentBack.content).toContain("steps[0].with.folder: unknown parameter for email.fetch");
    const reply = answered.messages[1];
    expect(reply).toMatchObject({ role: "assistant", text: "Every 15 minutes it drafts replies to recruiters.", compileErrors: null });
    expect(reply.proposal).toMatchObject({
      status: "open",
      diff: null,
      policy: { provenance: [expect.objectContaining({ source: "item.from" })] },
    });
    expect(reply.proposal!.source).toContain("name: Recruiter replies");
    expect(answered.costUsd).toBeCloseTo(0.03);
  });

  it("M7-U1: when the builder gives up on a broken proposal, the chat shows the compile errors and nothing to save", async () => {
    llm.answer(propose({ name: "x", steps: [{ id: "a", type: "llm.generate", with: {} }] }), say("I couldn't make it compile."));
    const chat = await send((await newChat()).chatId, "Write me a poem");
    const reply = chat.messages[1];
    expect(reply.proposal).toBeNull();
    expect(reply.compileErrors).toEqual([{ path: "steps[0].with.instruction", message: "is required" }]);
    await agent.post(`/api/builder/chats/${chat.chatId}/messages/${reply.messageId}/save`).expect(404);
  });

  it("M7-S1: the builder knows only catalog steps; another step type or parameter never becomes a proposal", async () => {
    llm.answer(
      propose({ name: "x", steps: [{ id: "run", type: "shell.exec", with: { command: "rm -rf /" } }] }),
      propose({ name: "x", steps: [{ id: "tell", type: "notify.telegram", with: { text: "hi", chatId: "123" } }] }),
      say("Neither works."),
    );
    const chat = await send((await newChat()).chatId, "Run a shell command");
    expect(toolResults(llm.requests[1])[0].content).toContain('unknown step type "shell.exec"');
    expect(toolResults(llm.requests[2])[0].content).toContain("steps[0].with.chatId: unknown parameter for notify.telegram");
    expect(chat.messages[1].proposal).toBeNull();
    expect(await db.client.pipeline.count()).toBe(0);

    // What it builds from: every catalog step with its parameters, nothing else.
    const { system, tools } = llm.requests[0];
    expect(system).toContain("## email.send");
    expect(system).toContain("to: string (email)");
    expect(system).not.toContain("shell");
    expect(tools.map((t) => t.name)).toEqual(["propose_pipeline", "propose_app", "draft_type", "list_runs", "read_run"]);
  });

  it("M7-S2: a builder-made pipeline still gets the gate before its side effect; saving it makes v1 of a new pipeline", async () => {
    llm.answer(propose(replies()), say("Done."));
    const chat = await send((await newChat()).chatId, "Draft replies to recruiters");
    const proposal = lastProposal(chat);
    expect(proposal.proposal!.definition.steps.map((s) => [s.id, s.autoInserted ?? false])).toEqual([
      ["fetch", false],
      ["triage", false],
      ["draft", false],
      ["sendGate", true],
      ["send", false],
    ]);
    expect(proposal.proposal!.source).not.toContain("sendGate");

    const saved = (await agent.post(`/api/builder/chats/${chat.chatId}/messages/${proposal.messageId}/save`).expect(200))
      .body as BuilderChatView;
    expect(saved.pipelineId).not.toBeNull();
    expect(saved.pipelineName).toBe("Recruiter replies");
    expect(lastProposal(saved).proposal).toMatchObject({ status: "saved", savedVersion: 1 });
    const version = await db.client.pipelineVersion.findFirstOrThrow({ where: { pipelineId: saved.pipelineId! } });
    expect(version).toMatchObject({ version: 1, builderChatId: chat.chatId });
    expect((version.definition as { steps: { id: string }[] }).steps.map((s) => s.id)).toContain("sendGate");
    await agent.post(`/api/builder/chats/${chat.chatId}/messages/${proposal.messageId}/save`).expect(409);
  });

  it("M7-T3: in a pipeline's chat the builder sees the current version once; its edit is a diff, saved as the next version", async () => {
    const pipeline = await createPipeline(replies());
    const chat = await newChat(pipeline.pipelineId);

    llm.answer(propose(replies(undefined, "Work"), "Read the Work mailbox"), say("It now reads Work."));
    const answered = await send(chat.chatId, "Read the Work mailbox instead of INBOX");
    expect(userText(llm.requests[0])).toMatch(/^<current_pipeline version="1" id="[0-9a-f-]+">\nname: Recruiter replies/);
    expect(userText(llm.requests[0])).toMatch(/Read the Work mailbox instead of INBOX$/);
    const proposal = lastProposal(answered).proposal!;
    expect(proposal.diff!.changes).toEqual([
      { kind: "step-changed", stepId: "fetch", field: "with.mailbox", before: "INBOX", after: "Work" },
    ]);

    // An unchanged proposal is refused to the builder, not shown to me.
    llm.answer(propose(replies()), say("That's what it does already."));
    await send(chat.chatId, "Keep INBOX after all?");
    expect(toolResults(llm.requests[3])[0]).toMatchObject({ is_error: true, content: "No changes compared to the current version." });

    const saved = (await agent.post(`/api/builder/chats/${chat.chatId}/messages/${lastProposal(answered).messageId}/save`).expect(200))
      .body as BuilderChatView;
    expect(lastProposal(saved).proposal).toMatchObject({ status: "saved", savedVersion: 2 });
    const detail = (await agent.get(`/api/pipelines/${pipeline.pipelineId}`).expect(200)).body as PipelineDetailView;
    expect(detail.currentVersion).toBe(2);
    expect(detail.versions[0].changeSummary).toContain("mailbox");

    // The conversation is replayed exactly (thinking blocks included); the new version is shown once more.
    llm.answer(say("OK"));
    await send(chat.chatId, "Thanks");
    const replayed = llm.last.messages;
    const stored = await db.client.builderMessage.findMany({ where: { builderChatId: chat.chatId }, orderBy: { dateCreated: "asc" } });
    expect(replayed.slice(0, -1)).toEqual(stored.flatMap((m) => (m.transcript as unknown[] | null) ?? []).slice(0, replayed.length - 1));
    expect(replayed.some((m) => m.content.some((b) => b.type === "thinking"))).toBe(true);
    expect(userText(llm.last)).toMatch(/^<current_pipeline version="2"/);
  });

  it("a new proposal supersedes the open one before it", async () => {
    llm.answer(propose(replies("First")), say("One."), propose(replies("Second")), say("Two."));
    const chat = await newChat();
    await send(chat.chatId, "Draft replies");
    const after = await send(chat.chatId, "Change the instruction");
    expect(after.messages.filter((m) => m.proposal).map((m) => m.proposal!.status)).toEqual(["superseded", "open"]);
    await agent.post(`/api/builder/chats/${chat.chatId}/messages/${after.messages[1].messageId}/save`).expect(409);
  });

  it("M7-T4: 'why did it skip X?' is answered from this pipeline's runs, shortened and marked as data", async () => {
    const pipeline = await createPipeline(replies());
    const other = await createPipeline({ ...replies(), name: "Other" });
    const run = await db.client.run.create({
      data: { userId, pipelineVersionId: pipeline.current!.pipelineVersionId, trigger: "schedule", status: "DONE", finishedAt: new Date() },
    });
    await db.client.step.create({
      data: {
        runId: run.runId,
        stepKey: "triage",
        type: "email.classify",
        status: "DONE",
        input: { instruction: "reply: recruiters" },
        output: {
          kept: [],
          dropped: [{ subject: "Senior .NET role at Acme", text: "x".repeat(5000) }],
          results: [{ index: 0, label: "skip", reason: "A mass mailing from an agency, not written to me." }],
        },
      },
    });
    const otherRun = await db.client.run.create({
      data: { userId, pipelineVersionId: other.current!.pipelineVersionId, trigger: "manual", status: "DONE" },
    });

    llm.answer(
      callTools(
        { name: "list_runs", input: {} },
        { name: "read_run", input: { runId: run.runId, stepKey: "triage" } },
        { name: "read_run", input: { runId: otherRun.runId } },
      ),
      say("It was labelled skip: a mass mailing from an agency."),
    );
    const chat = await send((await newChat(pipeline.pipelineId)).chatId, "Why did it skip the Acme job?");

    const [list, read, foreign] = toolResults(llm.requests[1]);
    expect(list.content).toContain(`${run.runId} · v1 · DONE · schedule`);
    expect(list.content).not.toContain(otherRun.runId);
    expect(read.content).toMatch(/^<run_data>\n/);
    expect(read.content).toContain("## triage (email.classify): DONE");
    expect(read.content).toContain("A mass mailing from an agency, not written to me.");
    expect(read.content).toContain("… [5000 chars]");
    expect(read.content.length).toBeLessThan(3000);
    expect(foreign).toMatchObject({ is_error: true, content: "No such run of this pipeline." });
    expect(chat.messages[1].text).toBe("It was labelled skip: a mass mailing from an agency.");
  });

  it("M7-T5: a reflection suggestion shows in the pipeline's chat; the proposal made from it marks it done when saved", async () => {
    const pipeline = await createPipeline(replies());
    const { suggestionId } = await db.client.pipelineSuggestion.create({
      data: {
        userId,
        pipelineId: pipeline.pipelineId,
        text: "Only draft for emails written to me personally.",
        rationale: "8 of 10 rejected were newsletters",
        source: "reflection:r",
      },
    });
    const chat = await newChat(pipeline.pipelineId);
    expect(chat.suggestions).toEqual([expect.objectContaining({ suggestionId, text: "Only draft for emails written to me personally." })]);

    llm.answer(propose(replies("Reply only if it was written to me personally.")), say("Tightened."));
    const answered = await send(chat.chatId, "Apply this suggestion", suggestionId);
    expect(userText(llm.requests[0])).toContain(
      "<reflection_suggestion>\nOnly draft for emails written to me personally.\nWhy: 8 of 10 rejected were newsletters\n</reflection_suggestion>",
    );
    await agent.post(`/api/builder/chats/${chat.chatId}/messages/${lastProposal(answered).messageId}/save`).expect(200);
    expect(await db.client.pipelineSuggestion.findUniqueOrThrow({ where: { suggestionId } })).toMatchObject({ status: "DONE" });
    expect((await agent.get(`/api/builder/chats/${chat.chatId}`).expect(200)).body).toMatchObject({ suggestions: [] });

    // Only an open suggestion of this chat's pipeline.
    await agent.post(`/api/builder/chats/${chat.chatId}/messages`).send({ text: "again", suggestionId }).expect(400);
  });

  it("M7-T6: a chat stops at its token cap, mid-turn too; a new chat starts over", async () => {
    const chat = await newChat();
    await db.client.builderChat.update({ where: { builderChatId: chat.chatId }, data: { tokensUsed: 2_000_000 - 500 } });
    llm.answer(callTools({ name: "list_runs", input: {} }), say("never reached"));
    const stopped = await send(chat.chatId, "Draft replies");
    expect(stopped.messages[1]).toMatchObject({
      error: "This chat reached its token limit. Start a new chat to continue.",
      proposal: null,
    });
    expect(llm.requests).toHaveLength(1);
    expect(stopped.tokensUsed).toBe(2_000_000 - 500 + 1100);

    await agent.post(`/api/builder/chats/${chat.chatId}/messages`).send({ text: "Again" }).expect(409);
    llm.answer(say("Hello"));
    await send((await newChat()).chatId, "Again");
  });

  it("a failed turn is shown but left out of what the builder sees next", async () => {
    const chat = await newChat();
    llm.answer(() => {
      throw new Error("overloaded");
    });
    const failed = await send(chat.chatId, "First try");
    expect(failed.messages[1].error).toBe("The builder could not be reached: overloaded");

    llm.answer(say("Hi"));
    await send(chat.chatId, "Second try");
    expect(llm.last.messages).toHaveLength(1);
    // The failed turn's recipe list never reached the builder: shown again.
    expect(userText(llm.last)).toBe("<apps>\nnone yet\n</apps>\n\n<saved_recipes>\nnone yet\n</saved_recipes>\n\nSecond try");
  });

  it("M9: the builder sees the saved recipes in my message when they change; a chat keeps the system prompt it started with", async () => {
    const chat = await newChat();
    llm.answer(say("Which site?"));
    await send(chat.chatId, "Find .NET jobs on dev.bg every morning");
    expect(userText(llm.last)).toBe("<apps>\nnone yet\n</apps>\n\n<saved_recipes>\nnone yet\n</saved_recipes>\n\nFind .NET jobs on dev.bg every morning");
    const started = llm.last.system;
    expect((await db.client.builderChat.findUniqueOrThrow({ where: { builderChatId: chat.chatId } })).system).toBe(started);

    await db.client.siteRecipe.create({
      data: {
        userId,
        name: "dev.bg/search",
        site: "dev.bg",
        version: 1,
        steps: {
          url: "https://dev.bg/company/jobs/{category}/",
          params: { category: { description: "a dev.bg category" } },
          item: ".job-list-item",
          fields: { url: { selector: "a", attr: "href", required: true } },
        },
      },
    });
    try {
      llm.answer(say("Proposing"));
      await send(chat.chatId, "dev.bg");
      expect(userText(llm.last)).toBe("<saved_recipes>\n- dev.bg/search v1: params category (a dev.bg category)\n</saved_recipes>\n\ndev.bg");
      llm.answer(say("Done"));
      await send(chat.chatId, "Thanks");
      expect(userText(llm.last)).toBe("Thanks");

      // Earlier thinking is bound to the system prompt it was produced with: a later catalog doesn't replace it.
      await db.client.builderChat.update({ where: { builderChatId: chat.chatId }, data: { system: "The prompt this chat started with" } });
      llm.answer(say("Still here"));
      await send(chat.chatId, "Again");
      expect(llm.last.system).toBe("The prompt this chat started with");
    } finally {
      await db.client.siteRecipe.deleteMany();
    }
  });

  it(`a turn that keeps calling tools stops after ${MAX_CALLS_PER_TURN} calls`, async () => {
    llm.answer(...Array.from({ length: MAX_CALLS_PER_TURN + 1 }, () => callTools({ name: "list_runs", input: {} })));
    const chat = await send((await newChat()).chatId, "Loop");
    expect(chat.messages[1].error).toContain(`more than ${MAX_CALLS_PER_TURN} steps`);
    expect(llm.requests).toHaveLength(MAX_CALLS_PER_TURN);
  });

  it("a proposal for a new pipeline can be dry-run first: the draft and the chat then belong to a pipeline, saved as v1", async () => {
    llm.answer(propose(replies()), say("Done."));
    const chat = await send((await newChat()).chatId, "Draft replies");
    const messageId = lastProposal(chat).messageId;
    const dry = (await agent.post(`/api/builder/chats/${chat.chatId}/messages/${messageId}/dry-run`).expect(202))
      .body as BuilderDryRunResponse;
    expect(dry.run).toMatchObject({ dryRun: true, status: "QUEUED", version: 1 });
    expect(dry.chat.pipelineId).toBe(dry.run.pipelineId);
    expect((await agent.get(`/api/builder/chats?pipelineId=${dry.run.pipelineId}`).expect(200)).body).toEqual([
      expect.objectContaining({ chatId: chat.chatId, title: "Draft replies" }),
    ]);

    await agent.post(`/api/builder/chats/${chat.chatId}/messages/${messageId}/save`).expect(200);
    const detail = (await agent.get(`/api/pipelines/${dry.run.pipelineId}`).expect(200)).body as PipelineDetailView;
    expect(detail).toMatchObject({ currentVersion: 1, hasDraft: false });
  });

  it("chats are mine only; one turn at a time per chat", async () => {
    const chat = await newChat();
    await agent.get("/api/builder/chats/00000000-0000-4000-8000-000000000000").expect(404);
    await agent.post("/api/builder/chats").send({ pipelineId: "00000000-0000-4000-8000-000000000000" }).expect(404);

    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const blocking: ScriptedChat["send"] = async () => {
      await slow;
      return {
        content: [{ type: "text", text: "late" }],
        stopReason: "end_turn",
        usage: { models: [], calls: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      };
    };
    const original = llm.send.bind(llm);
    llm.send = blocking;
    try {
      const first = agent
        .post(`/api/builder/chats/${chat.chatId}/messages`)
        .send({ text: "one" })
        .then((r) => r);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await agent.post(`/api/builder/chats/${chat.chatId}/messages`).send({ text: "two" }).expect(409);
      release();
      expect((await first).status).toBe(200);
    } finally {
      release();
      llm.send = original;
    }
  });
});

describe("builder chat without ANTHROPIC_API_KEY", () => {
  it("says the builder is unavailable instead of failing", async () => {
    const api = await createTestApp({ builderLlm: null });
    try {
      const agent = await api.signedIn();
      const chat = (await agent.post("/api/builder/chats").send({}).expect(201)).body as BuilderChatView;
      expect(chat.available).toBe(false);
      await agent.post(`/api/builder/chats/${chat.chatId}/messages`).send({ text: "hi" }).expect(503);
    } finally {
      const db = createPrismaConnection();
      await db.client.builderChat.deleteMany();
      await db.close();
      await api.close();
    }
  });
});
