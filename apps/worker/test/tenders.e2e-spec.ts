import { payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { entityItem, readAppSource } from "@realentity/storm-shared";
import { exampleYaml } from "@realentity/storm-shared/example-files";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { DedupeStep, FilterStep, SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const SHA = "a".repeat(64);

// M58-T7: the Tenders App: a portal's calls and a feed's scored against your profile; you pick; each form filled for
// you to submit
describe("examples/apps/tenders.yaml", () => {
  const compiler = new PipelineCompiler(defaultCatalog());
  const appSource = exampleYaml("apps/tenders.yaml");
  const definition = readAppSource(appSource);
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let extract: Counting;
  let score: Counting;
  let mapForm: Counting;
  let fill: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    const app = await db.client.app.create({ data: { userId, name: "Tenders" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: appSource } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
    await db.client.dataEntity.create({
      data: { appId, type: "Profile", key: "Acme Studio", value: { name: "Acme Studio" }, mine: { about: "Web software for public bodies.", avoid: "Hardware." } },
    });
    const portal = new Counting("browser.extract", () => ({
      items: [
        { url: "https://tenders.example/t/1", title: "City portal rebuild", buyer: "City of Example", deadline: "15 Dec 2026", budget: "€ 120 000", summary: "A new web portal.", source: "tenders.example/search" },
        { url: "https://tenders.example/t/2", title: "Office printers", buyer: "Ministry", summary: "500 printers.", source: "tenders.example/search" },
      ],
      pages: 1,
    }));
    const feed = new Counting("http.fetch", () => ({
      items: [{ url: "https://grants.example/c/9", title: "Digital services grant", summary: "Grants for web services.", published: "2026-11-20", id: "9", source: "grants.example" }],
      json: null,
      text: "",
      documents: [{ url: "https://grants.example/calls/feed.xml", status: 200, notModified: false, contentType: "application/rss+xml", title: "Calls", truncated: false }],
    }));
    extract = new Counting("llm.extract", (input) => {
      const { title } = input.content as { title: string };
      const read: Record<string, Record<string, string>> = {
        "City portal rebuild": { buyer: "City of Example", deadline: "2026-12-15", budget: "120 000 EUR" },
        "Office printers": { buyer: "Ministry", deadline: "", budget: "" },
        "Digital services grant": { buyer: "Grants Agency", deadline: "2027-01-31", budget: "50,000" },
      };
      return { values: read[title], missing: [], found: true };
    });
    // M59-T3: llm.score, as ScoreStep answers: each item with its score and reason, in order.
    score = new Counting("llm.score", (input) => {
      const fit: Record<string, [number, string]> = {
        "City portal rebuild": [88, "Web software for a city."],
        "Office printers": [5, "Hardware."],
        "Digital services grant": [64, "Web services, smaller."],
      };
      const scored = (input.items as { title: string }[]).map((item) => ({ ...item, score: fit[item.title][0], scoreReason: fit[item.title][1] }));
      return { scored, top: [...scored].sort((a, b) => b.score - a.score) };
    });
    // M59-T2: the portal's form is found and read; the grant has none online (apply by post): that item fails alone.
    mapForm = new Counting("browser.mapForm", (input) => {
      if (!(input.url as string).startsWith("https://tenders.example/")) throw new Error(`No application form on ${input.url as string} (nor behind an Apply button)`);
      return {
        formUrl: `${input.url as string}/apply`,
        fields: [{ key: "#company", label: "Company", type: "text", required: true, value: "Acme Studio", source: "profile" }],
        files: [{ key: "#profile", document: "company-profile", documentId: "6f1d9a52-7a3c-4a5e-9f0e-2b8c1d4e5f60", sha256: SHA, filename: "profile.pdf" }],
        submit: "Submit application",
        notes: "",
      };
    });
    fill = new Counting("browser.fillAndSubmit", (input) => ({ submitted: true, url: input.url as string, confirmation: "Thank you." }));
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([new ReadStep(db.client), new SaveStep(db.client), new MapStep(), new DedupeStep(db.client), new FilterStep(), portal, feed, extract, score, mapForm, fill]),
    );
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const tenders = async () =>
    Object.fromEntries(
      (await db.client.dataEntity.findMany({ where: { appId, type: "Tender" }, orderBy: { key: "asc" } })).map((r) => [r.key, { stage: r.stage, ...entityItem(r.value, r.mine) }]),
    );
  const run = async () =>
    runner.start(await createVersion(db.client, userId, exampleYaml("tenders.yaml"), compiler, { app: definition }), { trigger: "schedule", triggerData: {} });
  /** Each gate as the inbox decides it: the shortlist picks `pick`; each filled form approved. */
  const decide = async (runId: string, pick: string[]) => {
    for (let status = await runner.advance(runId); status !== "DONE"; status = await runner.advance(runId)) {
      if (status === "FAILED") {
        const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
        throw new Error(failed.map((f) => `${f.stepKey}: ${f.error}`).join("\n"));
      }
      expect(status).toBe("WAITING_FOR_USER");
      for (const p of await db.client.proposal.findMany({ where: { runId, status: "PENDING_REVIEW" } })) {
        const offered = p.originalPayload as { items?: { url: string }[] };
        const payload = (p.stepKey === "shortlist" ? { items: offered.items!.filter((i) => pick.includes(i.url)) } : offered) as Prisma.InputJsonValue;
        await db.client.proposal.update({ where: { proposalId: p.proposalId }, data: { status: "APPROVED", finalPayload: payload, payloadHash: payloadHash(payload) } });
      }
    }
  };

  it("new calls scored against your profile and kept; the ones worth a look offered, the best first; the picked one's form filled for you to submit", async () => {
    const runId = await run();
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    const about = "We are Acme Studio: Web software for public bodies.\nNot for us: Hardware.";
    expect(extract.calls[0].instruction).toBe(`An open tender or grant call. Who we are:\n${about}`);
    // M59-T3: one llm.score over the new calls, against the profile.
    expect(score.calls).toHaveLength(1);
    expect(score.calls[0].against).toBe(about);
    expect((score.calls[0].items as { title: string }[]).map((i) => i.title)).toEqual(["City portal rebuild", "Office printers", "Digital services grant"]);
    expect(await tenders()).toMatchObject({
      "https://tenders.example/t/1": { stage: "new", buyer: "City of Example", deadline: "2026-12-15", budget: 120000, score: 88, why: "Web software for a city." },
      "https://tenders.example/t/2": { stage: "new", score: 5 },
      "https://grants.example/c/9": { stage: "new", buyer: "Grants Agency", budget: 50000, score: 64, source: "grants.example" },
    });
    const [review] = await db.client.proposal.findMany({ where: { runId, stepKey: "shortlist" } });
    expect((review.originalPayload as { items: { url: string }[] }).items.map((i) => i.url)).toEqual(["https://tenders.example/t/1", "https://grants.example/c/9"]);

    await decide(runId, ["https://tenders.example/t/1"]);
    expect(mapForm.calls).toHaveLength(1);
    expect(mapForm.calls[0]).toMatchObject({ url: "https://tenders.example/t/1", document: "company-profile", about: { call: { title: "City portal rebuild" }, us: about } });
    expect(mapForm.calls[0].job).toBeUndefined();
    expect(fill.calls).toHaveLength(1);
    expect(fill.calls[0]).toMatchObject({ url: "https://tenders.example/t/1/apply", stopBeforeSubmit: true, fields: [{ key: "#company", value: "Acme Studio" }], files: [{ document: "company-profile" }] });
    const after = await tenders();
    expect(after["https://tenders.example/t/1"]).toMatchObject({ stage: "prepared", score: 88 });
    expect(after["https://grants.example/c/9"]).toMatchObject({ stage: "new" });
  });

  it("a call whose form isn't found: nothing waits to be sent, it stays new; the others go on", async () => {
    await decide(await run(), ["https://grants.example/c/9", "https://tenders.example/t/1"]);
    expect(mapForm.calls).toHaveLength(2);
    expect(fill.calls.map((c) => c.url)).toEqual(["https://tenders.example/t/1/apply"]);
    const after = await tenders();
    expect(after["https://grants.example/c/9"]).toMatchObject({ stage: "new" });
    expect(after["https://tenders.example/t/1"]).toMatchObject({ stage: "prepared" });
  });

  it("the next day: the calls seen before aren't scored again", async () => {
    await decide(await run(), []);
    expect(extract.calls).toHaveLength(3);
    await decide(await run(), []);
    expect(extract.calls).toHaveLength(3);
    expect(fill.calls).toEqual([]);
  });

  it("no profile: nothing is scored, nor kept (scored once there is one)", async () => {
    await db.client.dataEntity.deleteMany({ where: { appId, type: "Profile" } });
    await decide(await run(), []);
    expect(extract.calls).toEqual([]);
    expect(score.calls).toEqual([]);
    expect(await tenders()).toEqual({});
  });
});
