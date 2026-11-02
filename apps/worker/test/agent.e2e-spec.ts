import { payloadHash, KeyRing } from "@ai-me/crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection, type Proposal } from "@ai-me/db";
import { ModelRouter } from "@ai-me/llm";
import { factKey } from "@ai-me/shared";
import { defaultCatalog, type AgentAction, type FormFile } from "@ai-me/steps";
import { TestEnvironment } from "@ai-me/testing";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/browser/artifact-store";
import { BrowserPool } from "../src/browser/browser-pool";
import { DocumentStore } from "../src/browser/document-store";
import { SessionStore } from "../src/browser/session-store";
import { Asker } from "../src/learning/asker";
import { Facts } from "../src/learning/facts";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { RunControls } from "../src/runner/run-controls";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { TakeoverDesk } from "../src/runner/takeovers";
import { CredentialVault } from "../src/secrets/credential-vault";
import { BrowserAgentStep, BrowserSubmitStep } from "../src/steps/agent-steps";
import { startFixtureSites, type FixtureSites } from "./support/fixture-sites";
import { click, ref, ScriptedChat, type, type Move } from "./support/scripted-chat";
import { createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const PROFILE = "Ana Petrova · ana@aime.test · +359 88 123 4567 · Sofia · EU citizen · notice period: 1 month";
const CV = Buffer.from("%PDF-1.4\n% Ana Petrova CV fixture\n%%EOF\n");

/** Up to the filled form: the dialog opened, name and email typed (in one turn), Sofia picked, my CV chosen, consent ticked. */
const FILL: Move[] = [
  click("button", /Apply for this role/),
  (page) => [type(/Full name/, "Ana Petrova")(page) as never, type(/Email/, "ana@aime.test")(page) as never],
  click("combobox", /Where are you based/),
  click("option", /^Sofia$/),
  (page) => ({ name: "attach", input: { ref: ref(page, "file", /Upload CV/), document: "cv-main" } }),
  (page) => ({ name: "check", input: { ref: ref(page, "checkbox", /processing of my data/), checked: true } }),
];
const READY: Move = (page) => ({ name: "finish", input: { outcome: "ready", submit: ref(page, "button", /Submit application/), answer: "Filled the form" } });

// M11: browser.agent on a site without a recipe, and browser.submit after the gate (no real site, a scripted model)
describe("browser agent", () => {
  let db: PrismaConnection;
  let userId: string;
  let sites: FixtureSites;
  let artifactsDir: string;
  let documentsDir: string;
  let pool: BrowserPool;
  let runner: PipelineRunner;
  const chat = new ScriptedChat();
  /** What the AI ME bot sent: the agent's questions (M18-T1). */
  const telegram: string[] = [];

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    sites = await startFixtureSites();
    artifactsDir = await mkdtemp(join(tmpdir(), "aime-artifacts-"));
    documentsDir = await mkdtemp(join(tmpdir(), "aime-documents-"));
    pool = new BrowserPool({ invisible: true });
    const keys = KeyRing.fromEnv(process.env);
    const vault = new CredentialVault(db.client, keys);
    const deps = {
      prisma: db.client,
      pool,
      sessions: new SessionStore(db.client, keys, vault),
      vault,
      artifacts: new ArtifactStore(artifactsDir),
      documents: new DocumentStore(documentsDir),
    };
    const sendTelegram = (_url: string, init?: { body?: string }) => {
      telegram.push((JSON.parse(init?.body ?? "{}") as { text: string }).text);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 9000 + telegram.length } })));
    };
    const asker = new Asker(db.client, { botToken: "123:abc", chatId: "42" }, "https://aime.test", sendTelegram as unknown as typeof fetch);
    const router = new ModelRouter(() => Promise.resolve(null));
    const executors = new ExecutorRegistry([new BrowserAgentStep({ ...deps, chat, router, facts: new Facts(db.client), asker }), new BrowserSubmitStep(deps)]);
    const desk = new TakeoverDesk(db.client, () => Promise.resolve(), { timeoutMs: 10_000, pollMs: 100 });
    runner = new PipelineRunner(db.client, defaultCatalog(), executors, new RunControls(db.client), undefined, desk);
  });

  beforeEach(async () => {
    await db.client.userSetting.upsert({ where: { userId }, create: { userId, profile: PROFILE }, update: { profile: PROFILE } });
    const row = await db.client.document.create({
      data: { userId, name: "cv-main", filename: "Ana Petrova CV.pdf", mime: "application/pdf", size: CV.length, sha256: sha(CV), path: "pending" },
    });
    await writeFile(join(documentsDir, `${row.documentId}.pdf`), CV);
    await db.client.document.update({ where: { documentId: row.documentId }, data: { path: `${row.documentId}.pdf` } });
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.application.deleteMany();
    await db.client.jobPosting.deleteMany();
    await db.client.document.deleteMany();
    await db.client.fact.deleteMany();
    await db.client.userSetting.deleteMany();
    telegram.length = 0;
    sites.reset();
  });

  afterAll(async () => {
    await pool.close();
    await sites.stop();
    await rm(artifactsDir, { recursive: true, force: true });
    await rm(documentsDir, { recursive: true, force: true });
    await db.close();
  });

  const sha = (content: Buffer) => createHash("sha256").update(content).digest("hex");
  const posting = () => sites.url("careers", "/jobs/3");
  const PIPELINE = (maxActions = 15, policy = "careers.localhost") => `name: Agent apply
policy: { allowedDomains: [${policy}] }
steps:
  - id: agent
    type: browser.agent
    with:
      url: "${posting()}"
      goal: Find the application form and fill it from my profile
      documents: [cv-main]
      job: { url: "${posting()}", title: Backend Engineer, company: Northwind }
      maxActions: ${maxActions}
  - id: send
    type: browser.submit
    with:
      url: "{{agent.url}}"
      actions: "{{agent.actions}}"
      files: "{{agent.files}}"
      submit: "{{agent.submit}}"
      job: "${posting()}"
`;
  /** Only the agent's step: what it does, without a gate. */
  const AGENT_ONLY = (maxActions = 15) => PIPELINE(maxActions).split("  - id: send")[0];

  const run = async (source: string) => {
    await db.client.jobPosting.upsert({
      where: { userId_url: { userId, url: posting() } },
      create: { userId, source: "careers", url: posting(), title: "Backend Engineer", company: "Northwind" },
      update: {},
    });
    const runId = await runner.start(await createVersion(db.client, userId, source), { trigger: "manual" });
    return { runId, status: await runner.advance(runId) };
  };
  const agentStep = (runId: string) => db.client.step.findFirstOrThrow({ where: { runId, stepKey: "agent" } });
  const sendStep = (runId: string) => db.client.step.findFirstOrThrow({ where: { runId, stepKey: "send" } });
  const posted = () => sites.posts.filter((p) => p.host === "careers.localhost");
  /** The form sent (repeating the actions saves drafts: the approved values may go to the site then). */
  const applications = () => posted().filter((p) => p.path === "/api/applications");
  const evil = () => [...sites.hits, ...sites.posts.map((p) => `${p.host} ${p.path}`)].filter((h) => h.startsWith("evil.localhost"));

  async function approve(proposal: Proposal, edit = (p: Record<string, unknown>) => p) {
    const finalPayload = edit(structuredClone(proposal.originalPayload as Record<string, unknown>));
    await db.client.proposal.update({
      where: { proposalId: proposal.proposalId },
      data: { status: "APPROVED", finalPayload: finalPayload as Prisma.InputJsonValue, payloadHash: payloadHash(finalPayload) },
    });
  }
  const until = async <T>(read: () => Promise<T | null | undefined>, what: string): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const resolve = (takeoverId: string) =>
    db.client.takeover.update({ where: { takeoverId }, data: { status: "CONTINUED", resolvedAt: new Date() } });

  it("M11-T1/T2: fills a form a recipe can't (dialog, custom combobox, hidden upload) and sends nothing; the gate shows it", async () => {
    chat.play([...FILL, READY]);
    const { runId, status } = await run(PIPELINE());
    expect(status).toBe("WAITING_FOR_USER");

    const output = (await agentStep(runId)).output as { outcome: string; actions: AgentAction[]; files: FormFile[]; submit: unknown; notes: string };
    expect(output.outcome).toBe("ready");
    expect(output.actions.map((a) => [a.kind, "target" in a ? a.target.name : a.url, "value" in a ? a.value : "document" in a ? a.document : null])).toEqual([
      ["click", "Apply for this role", null],
      ["type", "Full name", "Ana Petrova"],
      ["type", "Email", "ana@aime.test"],
      ["click", "Where are you based?", null],
      ["click", "Sofia", null],
      ["attach", "Upload CV", "cv-main"],
      ["check", "I agree to the processing of my data for this application", true],
    ]);
    const cv = await db.client.document.findFirstOrThrow({ where: { name: "cv-main" } });
    expect(output.files).toEqual([{ key: "#cvFile", document: "cv-main", documentId: cv.documentId, sha256: sha(CV), filename: "Ana Petrova CV.pdf" }]);
    expect(output.submit).toEqual({ css: expect.any(String) as unknown, role: "button", name: "Submit application" });
    expect(output.notes).toBe('A check that you\'re a person ("3 + 4 ="): you answer it in the live view before it is sent.');

    // Nothing left the page: the draft that saves itself as I type was blocked, no file was picked.
    expect(posted()).toEqual([]);
    expect(chat.results().some((r) => r.includes("tried to send what you typed"))).toBe(true);
    // The model saw my profile and the documents it may attach; the Sonnet default; the Application prepared.
    expect(JSON.stringify(chat.requests[0].messages[0])).toContain(PROFILE);
    expect(JSON.stringify(chat.requests[0].messages[0])).toContain("<documents>cv-main</documents>");
    expect(chat.requests[0].choice.model).toBe("claude-sonnet-5-5");
    expect(chat.requests[0].tools.map((t) => t.name)).toEqual(["navigate", "click", "type", "select", "check", "attach", "read", "screenshot", "ask", "finish"]);
    expect(await db.client.application.findFirstOrThrow()).toMatchObject({ status: "PREPARED", runId });

    // The gate: browser.submit's exact payload, on the pipeline's own site.
    const proposal = await db.client.proposal.findFirstOrThrow({ where: { runId } });
    expect(proposal.stepKey).toBe("send");
    expect(proposal.targets).toEqual([{ field: "url", kind: "domain", value: "careers.localhost", basis: "static", isNew: false }]);
    expect((proposal.originalPayload as { actions: unknown[] }).actions).toEqual(output.actions);
  });

  it("M11-T2: after Act, browser.submit repeats exactly the approved actions, my edit included, waits for my person check, and sends", async () => {
    chat.play([...FILL, READY]);
    const { runId } = await run(PIPELINE());
    const proposal = await db.client.proposal.findFirstOrThrow({ where: { runId } });
    await approve(proposal, (p) => {
      const typed = (p.actions as AgentAction[]).find((a) => a.kind === "type" && a.target.name === "Email") as { value: string };
      typed.value = "ana.petrova@aime.test";
      return p;
    });
    const advancing = runner.advance(runId);
    const takeover = await until(() => db.client.takeover.findFirst({ where: { runId, status: "OPEN" } }), "the person check");
    expect(takeover.reason).toBe('Answer "3 + 4 =" in the form yourself, then Continue: it is sent then');
    expect(applications()).toEqual([]);
    await resolve(takeover.takeoverId);
    const status = await advancing;
    // When it fails, say why (M18-T3 found a race this way): the step's error, the takeovers, what the site got.
    if (status !== "DONE") {
      const takeovers = await db.client.takeover.findMany({ where: { runId }, orderBy: { requestedAt: "asc" } });
      throw new Error(
        `${status}: ${(await sendStep(runId)).error}; takeovers ${JSON.stringify(takeovers.map((t) => [t.reason, t.status]))}; ` +
          `the site got ${JSON.stringify(sites.posts.map((p) => `${p.host} ${p.path}`))}`,
      );
    }

    const sentForm = applications();
    expect(sentForm).toHaveLength(1);
    const part = (name: string) => new RegExp(`name="${name}"(?:; filename="[^"]*")?\\r\\n(?:Content-Type: [^\\r]*\\r\\n)?\\r\\n([\\s\\S]*?)\\r\\n--`).exec(sentForm[0].body)?.[1];
    expect(part("fullName")).toBe("Ana Petrova");
    expect(part("mail")).toBe("ana.petrova@aime.test");
    expect(part("city")).toBe("Sofia");
    expect(part("consent")).toBe("on");
    expect(sentForm[0].body).toContain('name="cv"; filename="Ana Petrova CV.pdf"');
    expect(part("cv")).toBe(CV.toString());
    expect((await sendStep(runId)).output).toMatchObject({ submitted: true, confirmation: expect.stringContaining("Thanks, we received your application.") as unknown });
    expect(await db.client.application.findFirstOrThrow()).toMatchObject({ status: "SUBMITTED" });
    expect(await db.client.jobPosting.findFirstOrThrow()).toMatchObject({ status: "APPLIED" });
  });

  it("M11-S1: navigation outside the allowed sites is blocked: typed, clicked, or a redirect by the page or its server", async () => {
    chat.play([
      () => ({ name: "navigate", input: { url: sites.url("evil", "/collect") } }),
      click("link", /Partner site/),
      () => ({ name: "read", input: {} }),
      click("link", /See our team/),
      () => ({ name: "navigate", input: { url: sites.url("careers", "/old-team") } }),
      () => ({ name: "finish", input: { outcome: "done", answer: "Nothing to do" } }),
    ]);
    const { runId, status } = await run(AGENT_ONLY());
    expect(status).toBe("DONE");
    const results = chat.results();
    expect(results[0]).toMatch(/^evil\.localhost is not one of the allowed sites/);
    expect(results[1]).toMatch(/^That link goes to evil\.localhost, not an allowed site/);
    expect(results[3]).toMatch(/blocked: evil\.localhost is not one of the allowed sites/);
    expect(results[4]).toMatch(/blocked: careers\.localhost redirected to evil\.localhost, which is not one of the allowed sites/);
    expect(evil()).toEqual([]);
    expect((await agentStep(runId)).output).toMatchObject({ outcome: "done", actions: [] });
  });

  it("M11-S2: at its action budget the agent stops and reports; the run fails, nothing to approve", async () => {
    chat.play([click("button", /Apply for this role/)]);
    const { runId, status } = await run(PIPELINE(3));
    expect(status).toBe("FAILED");
    expect((await agentStep(runId)).error).toMatch(/^Stopped after 3 actions, the limit, without finishing/);
    // Three actions and the one turn to finish: no more calls than that.
    expect(chat.requests).toHaveLength(4);
    expect(chat.results()[2]).toContain("That was your last action: call finish now");
    expect(await db.client.proposal.count({ where: { runId } })).toBe(0);
  });

  it("M11-S3: the agent can't submit: a submit button is refused, a button that sends what it typed is blocked", async () => {
    chat.play([
      ...FILL.slice(0, 2),
      click("button", /Submit application/),
      click("button", /Save draft/),
      () => ({ name: "finish", input: { outcome: "done", answer: "stop" } }),
    ]);
    const { runId } = await run(AGENT_ONLY());
    const results = chat.results();
    expect(results[3]).toMatch(/^"Submit application" submits the form: that's for after I approve/);
    expect(results[4]).toMatch(/the page tried to send what you typed to careers\.localhost/);
    expect(posted()).toEqual([]);
    // Neither click is an action to repeat.
    const actions = ((await agentStep(runId)).output as { actions: AgentAction[] }).actions;
    expect(actions.map((a) => ("target" in a ? a.target.name : a.kind))).toEqual(["Apply for this role", "Full name", "Email"]);
  });

  it("M11-S4: a page asking for ~/.ssh gets nothing: only the given documents attach, and only approved files upload", async () => {
    chat.play([
      click("button", /Apply for this role/),
      (page) => ({ name: "attach", input: { ref: ref(page, "file", /Upload CV/), document: "~/.ssh/id_rsa" } }),
      ...FILL.slice(1),
      READY,
    ]);
    const { runId } = await run(PIPELINE());
    expect(chat.results()[1]).toMatch(/^"~\/\.ssh\/id_rsa" is not one of the documents you may attach/);
    expect(((await agentStep(runId)).output as { files: FormFile[] }).files.map((f) => f.document)).toEqual(["cv-main"]);

    // An approved payload whose attach names a file it wasn't given is refused before anything goes.
    const proposal = await db.client.proposal.findFirstOrThrow({ where: { runId } });
    await approve(proposal, (p) => {
      const attach = (p.actions as AgentAction[]).find((a) => a.kind === "attach") as { document: string };
      attach.document = "secrets";
      return p;
    });
    expect(await runner.advance(runId)).toBe("FAILED");
    expect((await sendStep(runId)).error).toBe('Nothing was sent: "secrets" for "Upload CV" is not an approved file');
    expect(applications()).toEqual([]);
  });

  it("M11-T4: three failed actions in a row hand the page to the stronger model, in a new conversation with what was done", async () => {
    const missing: Move = () => ({ name: "click", input: { ref: "e9999" } });
    chat.play([
      click("button", /Apply for this role/),
      missing,
      missing,
      missing,
      (page) => ({ name: "finish", input: { outcome: "ready", submit: ref(page, "button", /Submit application/), answer: "Found the form" } }),
    ]);
    const { runId } = await run(AGENT_ONLY());
    expect(chat.requests.map((r) => r.choice.model)).toEqual([...Array<string>(4).fill("claude-sonnet-5-5"), "claude-opus-5-5"]);
    const handover = chat.requests[4];
    expect(handover.messages).toHaveLength(1);
    expect(JSON.stringify(handover.messages[0])).toContain('clicked button \\"Apply for this role\\"');
    expect(JSON.stringify(handover.messages[0])).toContain("3 actions in a row failed");
    expect(handover.system).toBe(chat.requests[0].system);
    expect((await agentStep(runId)).output).toMatchObject({ outcome: "ready" });
  });

  it("an element gone since approval pauses browser.submit; Continue on the same page fails it with nothing sent", async () => {
    chat.play([...FILL, READY]);
    const { runId } = await run(PIPELINE());
    await approve(await db.client.proposal.findFirstOrThrow({ where: { runId } }));
    sites.renameSubmit();
    const advancing = runner.advance(runId);
    const takeover = await until(() => db.client.takeover.findFirst({ where: { runId, status: "OPEN" } }), "the pause");
    expect(takeover.reason).toBe(`The page changed since I approved it (button "Submit application" isn't there); nothing was sent`);
    await resolve(takeover.takeoverId);
    expect(await advancing).toBe("FAILED");
    expect((await sendStep(runId)).error).toBe('Nothing was sent: button "Submit application" isn\'t on the page');
    expect(applications()).toEqual([]);
  });

  // M18-T1: what neither my profile nor my facts say, the agent asks me (M15-T3's Asker); never a secret, and a few times only.
  describe("M18: the agent asks me", () => {
    /** What the api does with my answer (FactsService.answer): the fact, the question answered, the wait continued. */
    async function answer(questionId: string, text: string) {
      const question = await db.client.question.findUniqueOrThrow({ where: { questionId } });
      const fact = await db.client.fact.create({ data: { userId, key: factKey(question.question), question: question.question, answer: text, source: "ASKED", site: question.site } });
      await db.client.question.update({ where: { questionId }, data: { status: "ANSWERED", answer: text, factId: fact.factId, answeredAt: new Date() } });
      await db.client.takeover.updateMany({ where: { runId: question.runId, waitsFor: "answer", status: "OPEN" }, data: { status: "CONTINUED" } });
      return fact;
    }
    /** Answers each question as it is asked, until the run is done. */
    function answering(runId: string, text: string) {
      let on = true;
      const loop = (async () => {
        while (on) {
          // Once the run waits (the question is saved and sent first): answered earlier, nothing would continue it.
          const waiting = await db.client.takeover.findFirst({ where: { runId, waitsFor: "answer", status: "OPEN" } });
          const open = waiting && (await db.client.question.findFirst({ where: { runId, status: "OPEN" } }));
          if (open) await answer(open.questionId, text);
          await new Promise((r) => setTimeout(r, 50));
        }
      })();
      return async () => {
        on = false;
        await loop;
      };
    }
    const ask = (question: string): Move => () => ({ name: "ask", input: { question } });

    it("M18-I1: asked on Telegram, my answer typed with source asked and kept as a fact; the gate shows it", async () => {
      sites.askStartDate();
      chat.play([
        ...FILL,
        ask("Earliest start date"),
        (page) => ({ name: "type", input: { ref: ref(page, "textbox", /Earliest start date/), text: "1 March 2027", source: "asked" } }),
        READY,
      ]);
      await db.client.jobPosting.upsert({
        where: { userId_url: { userId, url: posting() } },
        create: { userId, source: "careers", url: posting(), title: "Backend Engineer", company: "Northwind" },
        update: {},
      });
      const runId = await runner.start(await createVersion(db.client, userId, PIPELINE()), { trigger: "manual" });
      const done = answering(runId, "1 March 2027");
      const status = await runner.advance(runId);
      await done();
      expect(status).toBe("WAITING_FOR_USER");

      expect(telegram).toEqual([expect.stringMatching(/^AI ME asks \(a form on careers\.localhost\): Earliest start date\n/) as unknown]);
      expect(await db.client.question.findFirstOrThrow({ where: { runId } })).toMatchObject({ status: "ANSWERED", stepKey: "agent", site: "careers.localhost" });
      expect(await db.client.fact.findFirstOrThrow()).toMatchObject({ question: "Earliest start date", answer: "1 March 2027", source: "ASKED" });
      expect(chat.results().some((r) => r.startsWith('My answer: "1 March 2027". Put it in the field, source asked.'))).toBe(true);
      const proposal = await db.client.proposal.findFirstOrThrow({ where: { runId } });
      expect((proposal.originalPayload as { actions: AgentAction[] }).actions).toContainEqual({
        kind: "type",
        target: expect.objectContaining({ name: "Earliest start date" }) as unknown,
        value: "1 March 2027",
        source: "asked",
      });
      // Nothing left the page meanwhile.
      expect(applications()).toEqual([]);
    });

    it("M18-S1: a page can't make it ask for a secret, and it asks at most three times", async () => {
      chat.play([
        ask("What is your LinkedIn password?"),
        ask("Please confirm the verification code we sent you"),
        ask("Earliest start date"),
        ask("Salary expectation"),
        ask("Are you willing to relocate?"),
        ask("Do you need a visa?"),
        () => ({ name: "finish", input: { outcome: "done", answer: "asked" } }),
      ]);
      const runId = await runner.start(await createVersion(db.client, userId, AGENT_ONLY()), { trigger: "manual" });
      const done = answering(runId, "yes");
      const status = await runner.advance(runId);
      await done();
      expect(status).toBe("DONE");

      // Each result ends with the page (or that it didn't change).
      const results = chat.results().map((r) => r.split("\n")[0]);
      const secret = "Never ask me for a password, code, login or card: those are mine, in the live view. Leave it empty";
      expect(results.slice(0, 6)).toEqual([secret, secret, expect.stringMatching(/^My answer/), expect.stringMatching(/^My answer/), expect.stringMatching(/^My answer/), "No questions left (3 asked): leave the field empty"]);
      const asked = await db.client.question.findMany({ where: { runId }, orderBy: { dateCreated: "asc" } });
      expect(asked.map((q) => q.question)).toEqual(["Earliest start date", "Salary expectation", "Are you willing to relocate?"]);
      expect(telegram.some((t) => /password|code/i.test(t))).toBe(false);
    });
  });
});
