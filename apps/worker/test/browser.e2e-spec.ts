import { KeyRing, seal } from "@realentity/storm-crypto";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { TestEnvironment } from "@realentity/storm-testing";
import { defaultCatalog } from "@realentity/storm-steps";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/browser/artifact-store";
import { BrowserPool } from "../src/browser/browser-pool";
import { PageSecrets, zipEntries } from "../src/browser/page-secrets";
import { Quarantine } from "../src/browser/quarantine";
import { sessionName, SessionStore } from "../src/browser/session-store";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { RunControls } from "../src/runner/run-controls";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { TakeoverDesk } from "../src/runner/takeovers";
import { CredentialVault } from "../src/secrets/credential-vault";
import { BrowserOpenStep } from "../src/steps/browser-steps";
import { FILES, PASSWORD, startFixtureSites, USERNAME, type FixtureSites } from "./support/fixture-sites";
import { createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

// M8: the browser stack against local fixture sites (no real site), the headed slot without a window
describe("browser", () => {
  let db: PrismaConnection;
  let userId: string;
  let sites: FixtureSites;
  let keys: KeyRing;
  let artifactsDir: string;
  let pool: BrowserPool;
  let runner: PipelineRunner;
  let artifacts: ArtifactStore;
  const TAKEOVER_TIMEOUT = 4_000;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    sites = await startFixtureSites();
    keys = KeyRing.fromEnv(process.env);
    artifactsDir = await mkdtemp(join(tmpdir(), "storm-artifacts-"));
    pool = new BrowserPool({ invisible: true });
    artifacts = new ArtifactStore(artifactsDir);
    const vault = new CredentialVault(db.client, keys);
    const step = new BrowserOpenStep({ prisma: db.client, pool, sessions: new SessionStore(db.client, keys, vault), vault, artifacts });
    const desk = new TakeoverDesk(db.client, () => Promise.resolve(), { timeoutMs: TAKEOVER_TIMEOUT, pollMs: 100 });
    runner = new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry([step]), new RunControls(db.client), undefined, desk);
  });

  afterEach(async () => {
    await db.client.credential.deleteMany();
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    sites.reset();
  });

  afterAll(async () => {
    await pool.close();
    await sites.stop();
    await rm(artifactsDir, { recursive: true, force: true });
    await db.close();
  });

  const credential = async (name: string, allowedHosts: string[]) => {
    const credentialId = randomUUID();
    await db.client.credential.create({
      data: { credentialId, userId, name, allowedHosts, kind: "PASSWORD", username: USERNAME, ...seal(keys, credentialId, PASSWORD) },
    });
  };

  const open = (url: string, extra = "") => `name: Open
steps:
  - id: open
    type: browser.open
    with:
      url: ${url}
${extra
  .split("\n")
  .filter(Boolean)
  .map((line) => `      ${line}`)
  .join("\n")}
`;

  const startRun = async (source: string) => {
    const versionId = await createVersion(db.client, userId, source);
    return runner.start(versionId, { trigger: "manual" });
  };
  const stepOf = (runId: string) => db.client.step.findFirstOrThrow({ where: { runId, stepKey: "open" } });
  const until = async <T>(read: () => Promise<T | null | undefined | false>, what: string): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  /** Every file under the artifacts folder, zip entries inflated. */
  const storedContents = async (): Promise<Buffer[]> => {
    const files = (await readdir(artifactsDir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
    const contents: Buffer[] = [];
    for (const file of files) {
      const content = await readFile(join(file.parentPath, file.name));
      contents.push(content, ...(zipEntries(content) ?? []).map((e) => e.data));
    }
    return contents;
  };

  it("M8-I1, M8-S4: signs in once; the login is kept sealed and the second run is signed in already", async () => {
    await credential("app", ["app.localhost"]);
    const source = open(sites.url("app", "/account"), 'login: { credential: "{{cred:app}}" }\nwaitFor: "#ready"');

    const first = await startRun(source);
    expect(await runner.advance(first)).toBe("DONE");
    expect((await stepOf(first)).output).toMatchObject({
      signedIn: true,
      title: "Account",
      text: expect.stringContaining("Welcome back, Ana") as unknown,
    });
    expect(sites.posts).toEqual([{ host: "app.localhost", path: "/login", body: expect.stringContaining("password=") as unknown }]);

    const session = await db.client.credential.findUniqueOrThrow({
      where: { userId_name: { userId, name: sessionName("app.localhost") } },
    });
    expect(session).toMatchObject({ kind: "STORAGE_STATE", allowedHosts: ["app.localhost"] });

    const second = await startRun(source);
    expect(await runner.advance(second)).toBe("DONE");
    expect((await stepOf(second)).output).toMatchObject({ signedIn: false, text: expect.stringContaining("Welcome back, Ana") as unknown });
    expect(sites.posts).toHaveLength(1);

    // M8-S4: the session cookie and the password are in no stored file (traces included, inflated), no step row and
    // no temp folder; the sealed session doesn't show the cookie either.
    const [sid] = [...sites.sessions];
    const kinds = (await db.client.artifact.findMany({ where: { runId: first } })).map((a) => a.kind).sort();
    expect(kinds).toEqual(["screenshot", "trace"]);
    // Raw, URL-, form- and JSON-encoded.
    const probe = new PageSecrets();
    probe.add(PASSWORD);
    probe.add(sid);
    for (const content of await storedContents()) expect(probe.foundIn(content)).toBe(false);
    const steps = JSON.stringify(await db.client.step.findMany({ where: { runId: { in: [first, second] } } }));
    expect(steps).not.toContain(sid);
    expect(steps).not.toContain(PASSWORD);
    expect(Buffer.from(session.ciphertext).includes(sid)).toBe(false);
    expect((await readdir(tmpdir())).filter((name) => name.startsWith("storm-trace-"))).toEqual([]);
  });

  it("M8-S1: never fills a credential on a host outside its allowedHosts (a look-alike host)", async () => {
    await credential("app", ["app.localhost"]);
    const runId = await startRun(open(sites.url("app.localhost.evil", "/login"), 'login: { credential: "{{cred:app}}" }'));
    expect(await runner.advance(runId)).toBe("FAILED");
    expect((await stepOf(runId)).error).toBe('Credential "app" is not allowed on app.localhost.evil.localhost');
    expect(sites.posts).toEqual([]);
  });

  it("M8-S2: signs in on the listed SSO host it is redirected to, and only there", async () => {
    await credential("app", ["app.localhost", "sso.localhost"]);
    const source = open(sites.url("app", "/sso-account"), 'login: { credential: "{{cred:app}}" }\nwaitFor: "#ready"');
    const runId = await startRun(source);
    expect(await runner.advance(runId)).toBe("DONE");
    expect(sites.posts.map((p) => `${p.host} ${p.path}`)).toEqual(["sso.localhost /authorize"]);
    expect((await stepOf(runId)).output).toMatchObject({ signedIn: true, title: "Account" });

    await db.client.credential.deleteMany();
    sites.posts.length = 0;
    await credential("app", ["app.localhost"]);
    const refused = await startRun(source);
    expect(await runner.advance(refused)).toBe("FAILED");
    expect((await stepOf(refused)).error).toBe('Credential "app" is not allowed on sso.localhost');
    expect(sites.posts).toEqual([]);
  });

  it("M8-S3: what the LLM may see of a page (snapshot, text) has no credential value", async () => {
    const lease = await pool.lease(false, {});
    try {
      const page = await lease.context.newPage();
      await page.goto(sites.url("app", "/login"));
      const secrets = new PageSecrets();
      await page.locator('input[type="email"]').fill(USERNAME);
      await page.locator('input[type="password"]').fill(PASSWORD);
      secrets.add(PASSWORD, 'input[type="password"]');
      // A page that echoes the secret where an LLM would read it.
      await page.evaluate(`document.body.insertAdjacentHTML("beforeend", "<p>Your password is ${PASSWORD}</p>")`);

      const snapshot = await secrets.snapshot(page);
      expect(snapshot).toContain("textbox");
      expect(snapshot).not.toContain(PASSWORD);
      expect(secrets.mask(await page.locator("body").innerText())).not.toContain(PASSWORD);
      expect(secrets.masks(page)).toHaveLength(2);
    } finally {
      await lease.close();
    }
  });

  it("M8-I2: a CAPTCHA hands the live page to the user; Continue goes on from that page, without reloading it", async () => {
    const runId = await startRun(open(sites.url("app", "/captcha"), 'headed: true\nwaitFor: "#ready"'));
    const advancing = runner.advance(runId);

    const takeover = await until(() => db.client.takeover.findFirst({ where: { runId, status: "OPEN" } }), "the takeover");
    expect(takeover).toMatchObject({ reason: "CAPTCHA", stepKey: "open", url: sites.url("app", "/captcha") });
    expect((await db.client.run.findUniqueOrThrow({ where: { runId } })).status).toBe("WAITING_FOR_USER");
    // A job arriving for the run meanwhile doesn't claim it: its step still holds the page.
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");

    sites.solveCaptcha(); // what the user does in the live view
    await db.client.takeover.update({ where: { takeoverId: takeover.takeoverId }, data: { status: "CONTINUED", resolvedAt: new Date() } });
    expect(await advancing).toBe("DONE");
    expect((await stepOf(runId)).output).toMatchObject({ text: "Solved content" });
    expect(sites.hits.filter((h) => h === "app.localhost /captcha")).toHaveLength(1);
  });

  it("M8-T5: Take over pauses the run at its next step point; Abort stops it", async () => {
    const runId = await startRun(open(sites.url("app", "/slow"), 'headed: true\nwaitFor: "#ready"\ntimeoutSeconds: 20'));
    const advancing = runner.advance(runId);
    await until(async () => (await db.client.step.findFirst({ where: { runId, status: "RUNNING" } })) !== null, "the step");
    const { takeoverId } = await db.client.takeover.create({ data: { runId, status: "TAKEN_OVER", reason: "Taken over" } });
    await until(async () => (await db.client.run.findUniqueOrThrow({ where: { runId } })).status === "WAITING_FOR_USER", "the pause");
    expect((await db.client.takeover.findUniqueOrThrow({ where: { takeoverId } })).url).toBe(sites.url("app", "/slow"));

    await db.client.takeover.update({ where: { takeoverId }, data: { status: "ABORTED", resolvedAt: new Date() } });
    expect(await advancing).toBe("ABORTED");
    expect(await stepOf(runId)).toMatchObject({ status: "FAILED", error: "Aborted in the live view" });
  });

  it("nobody taking over fails the step; the kill switch stops a waiting run; headless can't be taken over", async () => {
    const ignored = await startRun(open(sites.url("app", "/captcha"), "headed: true"));
    expect(await runner.advance(ignored)).toBe("FAILED");
    expect((await stepOf(ignored)).error).toBe("CAPTCHA: nobody took over within 4 seconds");
    expect(await db.client.takeover.findFirst({ where: { runId: ignored } })).toMatchObject({ status: "EXPIRED" });

    const killed = await startRun(open(sites.url("app", "/captcha"), "headed: true"));
    const advancing = runner.advance(killed);
    await until(() => db.client.takeover.findFirst({ where: { runId: killed, status: "OPEN" } }), "the takeover");
    await db.client.run.update({ where: { runId: killed }, data: { status: "ABORTED", finishedAt: new Date() } }); // as the kill switch does
    expect(await advancing).toBe("ABORTED");

    const headless = await startRun(open(sites.url("app", "/captcha")));
    expect(await runner.advance(headless)).toBe("FAILED");
    expect((await stepOf(headless)).error).toContain("CAPTCHA: needs you, and this step has no live view (set headed: true");
  });

  it("after a restart an open takeover expires and its run runs the step again", async () => {
    const runId = await startRun(open(sites.url("app", "/account")));
    await db.client.run.update({ where: { runId }, data: { status: "WAITING_FOR_USER" } });
    await db.client.step.create({ data: { runId, stepKey: "open", type: "browser.open", status: "RUNNING" } });
    await db.client.takeover.create({ data: { runId, status: "OPEN", reason: "CAPTCHA" } });

    await new TakeoverDesk(db.client, () => Promise.resolve(), { timeoutMs: 1_000 }).recover();
    expect(await runner.recoverInterrupted()).toEqual([runId]);
    expect(await db.client.takeover.findFirst({ where: { runId } })).toMatchObject({ status: "EXPIRED" });
    expect(await runner.advance(runId)).toBe("DONE");
  });

  it("M8-I3: the headed slot takes one step at a time; headless steps share the headless browser", async () => {
    const first = await pool.lease(true, {});
    let second: Awaited<ReturnType<BrowserPool["lease"]>> | undefined;
    const waiting = pool.lease(true, {}).then((lease) => (second = lease));
    const headless = await pool.lease(false, {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(second).toBeUndefined();
    await headless.close();
    await first.close();
    await waiting;
    expect(second?.headed).toBe(true);
    await second?.close();
  });

  it("M8-S6: downloads stay in quarantine unless their size and content type are allowed", async () => {
    const quarantine = new Quarantine(db.client, artifacts, 2_048);
    const runId = await startRun(open(sites.url("app", "/downloads")));
    const owner = { userId, runId, stepKey: "open", itemIndex: null };
    const lease = await pool.lease(false, { acceptDownloads: true });
    const results = [];
    try {
      const page = await lease.context.newPage();
      await page.goto(sites.url("app", "/downloads"));
      for (const name of Object.keys(FILES)) {
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByText(name).click()]);
        results.push(await quarantine.accept(download, owner));
      }
    } finally {
      await lease.close();
    }
    expect(results.map((r) => (r.accepted ? `${r.name}: ok` : `${r.name}: ${r.reason}`))).toEqual([
      "report.pdf: ok",
      "notes.txt: ok",
      "invoice.pdf: its content isn't a .pdf file",
      "setup.exe: the type .exe isn't allowed",
      "scan.pdf: larger than 2 KB",
    ]);
    expect((await db.client.artifact.findMany({ where: { runId } })).map((a) => [a.kind, a.mime])).toEqual(
      expect.arrayContaining([
        ["download", "application/pdf"],
        ["download", "text/plain"],
      ]),
    );
    expect(await readdir(artifacts.quarantineDir(runId))).toEqual([]);
  });
});
