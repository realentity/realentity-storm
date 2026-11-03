import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { type AppDetailView, type AppDriftView, type BuilderChatView, type PipelineDetailView } from "@ai-me/shared";
import { TestEnvironment } from "@ai-me/testing";
import type request from "supertest";
import { callTools, say, ScriptedChat, toolResults, userText } from "./support/scripted-chat";
import { createTestApp, type TestApp } from "./support/test-app";

/** A reading list, as the builder would propose it: the App, and the pipeline that fills it. */
const READING = {
  name: "Reading list",
  icon: "book",
  types: {
    Book: {
      key: "url",
      title: "title",
      stages: {
        field: "status",
        initial: "new",
        states: ["new", "reading", "read"],
        moves: [
          { from: "new", to: ["reading"] },
          { from: "reading", to: ["read"] },
        ],
      },
      fields: {
        url: { type: "url", required: true },
        title: { type: "text", required: true },
        author: { type: "text" },
        rating: { type: "number", mine: true },
      },
    },
  },
};
const COLLECT = {
  name: "Book feed",
  app: "Reading list",
  policy: { allowedDomains: ["books.example.org"] },
  steps: [
    { id: "feed", type: "http.fetch", with: { url: "https://books.example.org/new.atom" } },
    { id: "save", type: "data.save", with: { items: "{{feed.items}}", type: "Book" } },
  ],
};
const proposeApp = (app: unknown, pipelines: unknown[], summary = "A reading list") =>
  callTools({ name: "propose_app", input: { summary, app, pipelines } });

// M34-T1, T2, T3: the builder proposes an App with its pipelines, saved together; changes one from a sentence
describe("the builder and Apps", () => {
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
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const newChat = async (body: object = {}) => (await agent.post("/api/builder/chats").send(body).expect(201)).body as BuilderChatView;
  const send = async (chatId: string, text: string) =>
    (await agent.post(`/api/builder/chats/${chatId}/messages`).send({ text }).expect(200)).body as BuilderChatView;

  it("T1: an App and its pipeline proposed as one change, its mistakes sent back, then saved together", async () => {
    const wrong = {
      ...COLLECT,
      steps: [COLLECT.steps[0], { id: "save", type: "data.save", with: { items: "{{feed.items}}", type: "Books" } }],
    };
    llm.answer(proposeApp(READING, [wrong]), proposeApp(READING, [COLLECT]), say("A reading list, filled from the feed."));
    const chat = await newChat();
    const answered = await send(chat.chatId, "Keep the books from this feed, and where I am with each.");

    expect(toolResults(llm.requests[1])[0]).toMatchObject({
      is_error: true,
      content: expect.stringContaining('pipelines[0].steps[1].with.type: "Reading list" has no type "Books"') as unknown,
    });
    expect(userText(llm.requests[0])).toContain("<apps>\nnone yet\n</apps>");
    const proposal = answered.messages[1].appProposal!;
    expect(proposal).toMatchObject({
      status: "open",
      summary: "A reading list",
      app: { name: "Reading list", isNew: true },
      pipelines: [{ name: "Book feed", isNew: true }],
    });
    expect(proposal.app.source).toContain("Book:");

    const saved = (await agent.post(`/api/builder/chats/${chat.chatId}/messages/${answered.messages[1].messageId}/save-app`).expect(201))
      .body as BuilderChatView;
    expect(saved.messages[1].appProposal).toMatchObject({ status: "saved", savedAppId: expect.any(String) as unknown });
    expect(saved.appId).toBe(saved.messages[1].appProposal!.savedAppId);
    const app = (await agent.get(`/api/apps/${saved.appId}`).expect(200)).body as AppDetailView;
    expect(app).toMatchObject({ name: "Reading list", version: 1, pipelines: [{ name: "Book feed" }] });
    await agent.post(`/api/builder/chats/${chat.chatId}/messages/${answered.messages[1].messageId}/save-app`).expect(409);
  });

  it("T2: a chat about an App sees it and its pipelines; a change that breaks one it leaves alone is refused", async () => {
    const app = (
      await agent
        .post("/api/apps")
        .send({ source: JSON.stringify(READING) })
        .expect(201)
    ).body as AppDetailView;
    const pipeline = (
      await agent
        .post("/api/pipelines")
        .send({ source: JSON.stringify(COLLECT) })
        .expect(201)
    ).body as PipelineDetailView;
    const renamed = { ...READING, types: { Novel: READING.types.Book } };
    const withPublisher = {
      ...READING,
      types: { Book: { ...READING.types.Book, fields: { ...READING.types.Book.fields, publisher: { type: "text" } } } },
    };
    llm.answer(proposeApp(renamed, []), proposeApp(withPublisher, [], "Books get their publisher"), say("Added the publisher."));
    const chat = await newChat({ appId: app.appId });
    const answered = await send(chat.chatId, "Add the publisher to books.");

    const seen = userText(llm.requests[0]);
    expect(seen).toContain('<current_app name="Reading list">');
    expect(seen).toContain("<app_pipeline>\nname: Book feed");
    expect(toolResults(llm.requests[1])[0].content).toContain(
      '"Book feed" (as it is).steps[1].with.type: "Reading list" has no type "Book"',
    );
    const proposal = answered.messages[1].appProposal!;
    expect(proposal.app).toMatchObject({ isNew: false, changes: ["Book.publisher added (text)"] });

    await agent.post(`/api/builder/chats/${chat.chatId}/messages/${answered.messages[1].messageId}/save-app`).expect(201);
    expect(((await agent.get(`/api/apps/${app.appId}`).expect(200)).body as AppDetailView).version).toBe(2);
    expect(((await agent.get(`/api/pipelines/${pipeline.pipelineId}`).expect(200)).body as PipelineDetailView).currentVersion).toBe(1);
  });

  it("T3: draft_type shows the builder what a run's step really gave", async () => {
    const pipeline = (
      await agent
        .post("/api/pipelines")
        .send({ source: JSON.stringify({ ...COLLECT, app: undefined, steps: [COLLECT.steps[0]] }) })
        .expect(201)
    ).body as PipelineDetailView;
    const run = await db.client.run.create({
      data: { userId, pipelineVersionId: pipeline.current!.pipelineVersionId, status: "DONE", trigger: "manual", dryRun: true },
    });
    await db.client.step.create({
      data: {
        runId: run.runId,
        stepKey: "feed",
        type: "http.fetch",
        status: "DONE",
        output: { items: [1, 2].map((n) => ({ url: `https://books.example.org/${n}`, title: `Book ${n}`, published: `2026-11-0${n}` })) },
      },
    });
    llm.answer(
      callTools({ name: "draft_type", input: { runId: run.runId, stepKey: "feed" } }),
      say("The feed gives url, title and published."),
    );
    await send((await newChat()).chatId, "What does the feed give?");
    expect(toolResults(llm.requests[1])[0].content).toContain("Drafted from 2 item(s):\nItem:\n  key: url");
  });

  it("a pipeline the builder proposes in an App compiles against it", async () => {
    await agent
      .post("/api/apps")
      .send({ source: JSON.stringify(READING) })
      .expect(201);
    llm.answer(callTools({ name: "propose_pipeline", input: { summary: "The feed", pipeline: COLLECT } }), say("Done."));
    const answered = await send((await newChat()).chatId, "Fill my reading list from the feed.");
    expect(answered.messages[1].proposal?.definition.app).toBe("Reading list");
  });

  // M34-T4
  it("T4: a field the entities have that their type lacks is suggested, and added as the next version", async () => {
    const app = (
      await agent
        .post("/api/apps")
        .send({ source: JSON.stringify(READING) })
        .expect(201)
    ).body as AppDetailView;
    await db.client.dataEntity.createMany({
      data: [1, 2, 3].map((n) => ({
        appId: app.appId,
        type: "Book",
        key: `https://books.example.org/${n}`,
        value: { url: `https://books.example.org/${n}`, title: `Book ${n}`, pages: 100 * n, isbn: `97800000000${n}` },
      })),
    });
    const drift = (await agent.get(`/api/apps/${app.appId}/drift`).expect(200)).body as AppDriftView[];
    expect(drift.map((d) => [d.type, d.field, d.count, d.suggested.type])).toEqual([
      ["Book", "isbn", 3, "number"],
      ["Book", "pages", 3, "number"],
    ]);
    const added = (await agent.post(`/api/apps/${app.appId}/drift`).send({ type: "Book", field: "pages" }).expect(201))
      .body as AppDetailView;
    expect(added).toMatchObject({
      version: 2,
      versions: [expect.objectContaining({ changeSummary: "Book.pages added (number)" }), expect.anything()],
    });
    expect(added.source).toContain("pages: { type: number }");
    expect(((await agent.get(`/api/apps/${app.appId}/drift`).expect(200)).body as AppDriftView[]).map((d) => d.field)).toEqual(["isbn"]);
  });
});
