import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { readAppSource } from "@realentity/storm-shared";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { Counting, createVersion } from "./support/test-steps";

const APP = (name: string) => `
name: ${name}
types:
  Incident:
    key: id
    fields: { id: { type: text } }
needs:
  repository: { kind: text, label: Repository }
`;

const TELL = (app: string) => `
name: Tell ${app}
app: ${app}
steps:
  - id: tell
    type: notify.telegram
    with: { text: "Issues of {{setting.repository}}" }
`;

// M50-I1 (the worker's half): each install's runs use its own settings
describe("bindings in runs", () => {
  let db: PrismaConnection;
  let userId: string;
  let telegram: Counting;
  let runner: PipelineRunner;
  const compiler = new PipelineCompiler(defaultCatalog());

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(() => {
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    runner = new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry([telegram]));
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const install = async (name: string, repository: string | null) => {
    const source = APP(name);
    const app = await db.client.app.create({ data: { userId, name } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    if (repository !== null) await db.client.binding.create({ data: { appId: app.appId, slot: "repository", text: repository } });
    return createVersion(db.client, userId, TELL(name), compiler, { app: readAppSource(source) });
  };
  const run = async (versionId: string) => {
    const runId = await runner.start(versionId, { trigger: "manual" });
    return { runId, status: await runner.advance(runId) };
  };

  it("runs each install's pipeline with that install's setting; one not set fails the step saying where to set it", async () => {
    expect((await run(await install("Ops one", "me/infra"))).status).toBe("DONE");
    expect((await run(await install("Ops two", "me/web"))).status).toBe("DONE");
    expect(telegram.calls.map((c) => c.text)).toEqual(["Issues of me/infra", "Issues of me/web"]);

    const unset = await run(await install("Ops three", null));
    expect(unset.status).toBe("FAILED");
    const step = await db.client.step.findFirstOrThrow({ where: { runId: unset.runId, stepKey: "tell" } });
    expect(step.error).toContain(`"repository" isn't set: set it on the pipeline's page (or its App's)`);
  });
});
