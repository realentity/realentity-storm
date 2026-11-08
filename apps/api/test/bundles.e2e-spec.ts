import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type AppDetailView, type BundleCheckView, type BundleExportView, type PipelineDetailView } from "@realentity/storm-shared";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const APP = `# my disks, from shops
name: Disks
icon: cpu
types:
  Disk:
    key: id                # one per shop's product id
    fields:
      id: { type: text, required: true }
      name: { type: text, required: true }
      price: { type: money, currency: currency }
      currency: { type: text }
`;

const SAVE = `name: Disk prices
app: Disks
steps:
  - id: save
    type: data.save
    with:
      type: Disk
      items:
        - { id: a, name: "WD Purple 8TB", price: 399, currency: BGN }
`;

const READ = `name: Cheapest disks
app: Disks
steps:
  - id: read
    type: data.read
    with: { type: Disk, sort: price, limit: 3 }
`;

// M35-T5: Apps and pipelines in and out as YAML files
describe("bundles", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const file = (...parts: string[]) => parts.join("---\n");
  const check = async (text: string) => (await agent.post("/api/bundles/check").send({ text }).expect(201)).body as BundleCheckView;

  // M35-I2
  it("imports an App with its pipelines from one file, App first; exported back the same", async () => {
    const text = file(APP, SAVE, READ);
    const preview = await check(text);
    expect(preview).toMatchObject({ ok: true, errors: [], broken: [] });
    expect(preview.items.map((i) => [i.kind, i.name, i.action])).toEqual([
      ["app", "Disks", "create"],
      ["pipeline", "Disk prices", "create"],
      ["pipeline", "Cheapest disks", "create"],
    ]);
    expect(await db.client.app.count()).toBe(0);

    const saved = (await agent.post("/api/bundles").send({ text }).expect(201)).body as BundleCheckView;
    const appId = saved.items[0].id!;
    const app = (await agent.get(`/api/apps/${appId}`).expect(200)).body as AppDetailView;
    expect(app.source).toBe(APP);
    expect(app.pipelines.map((p) => p.name).sort()).toEqual(["Cheapest disks", "Disk prices"]);

    // Exported: the App as written, then its pipelines; imported again, nothing changes.
    const exported = (await agent.get(`/api/bundles/apps/${appId}`).expect(200)).body as BundleExportView;
    expect(exported.filename).toBe("disks.yaml");
    expect(exported.text.startsWith(`${APP}---\n`)).toBe(true);
    expect((await check(exported.text)).items.map((i) => i.action)).toEqual(["same", "same", "same"]);

    // A changed file: the App's next version and the one pipeline that changed, with what changes.
    const changed = await check(
      file(
        APP.replace("      currency: { type: text }\n", "      currency: { type: text }\n      shop: { type: text }\n"),
        SAVE.replace("limit", "limit"),
        READ.replace("limit: 3", "limit: 5"),
      ),
    );
    expect(changed.items.map((i) => [i.name, i.action])).toEqual([
      ["Disks", "update"],
      ["Disk prices", "same"],
      ["Cheapest disks", "update"],
    ]);
    expect(changed.items[0].changes.join("\n")).toContain("shop");
    expect(changed.items[2].changes.length).toBeGreaterThan(0);
    await agent
      .post("/api/bundles")
      .send({
        text: file(
          APP.replace("      currency: { type: text }\n", "      currency: { type: text }\n      shop: { type: text }\n"),
          READ.replace("limit: 3", "limit: 5"),
        ),
      })
      .expect(201);
    expect(((await agent.get(`/api/apps/${appId}`).expect(200)).body as AppDetailView).version).toBe(2);

    const pipeline = (await db.client.pipeline.findFirstOrThrow({ where: { name: "Cheapest disks" } })).pipelineId;
    const one = (await agent.get(`/api/bundles/pipelines/${pipeline}`).expect(200)).body as BundleExportView;
    expect(one.filename).toBe("cheapest-disks.yaml");
    expect(one.text).toContain("limit: 5");
  });

  it("saves nothing when any part has a problem, each said where it is", async () => {
    const broken = file(APP, SAVE.replace("type: Disk\n", "type: Drive\n"), READ);
    const preview = await check(broken);
    expect(preview.ok).toBe(false);
    const save = preview.items.find((i) => i.name === "Disk prices")!;
    expect(save.errors[0].message).toContain("Drive");
    expect(save.errors[0].line).toBe(APP.split("\n").length + 1);
    const refused = await agent.post("/api/bundles").send({ text: broken }).expect(400);
    expect((refused.body as BundleCheckView).items).toHaveLength(3);
    expect(await db.client.app.count()).toBe(0);
    expect(await db.client.pipeline.count()).toBe(0);

    // An App with a problem: on its line in the file; its pipelines say so.
    const badApp = await check(file(APP.replace("currency: currency }", "currency: nope }"), READ));
    expect(badApp.items[0].errors).toEqual([expect.objectContaining({ path: "types.Disk.fields.price.currency", line: 10 })]);
    expect(badApp.items[1].errors.map((e) => e.message)).toContain("Its App in this file has problems");

    // Neither an App nor a pipeline; two Apps.
    expect((await check("just: a map\n")).errors[0].message).toContain("neither");
    expect((await check(file(APP, APP))).errors[0].message).toContain("One App a file");
  });

  it("refuses an App that would break one of my pipelines the file leaves out, and imports a pipeline alone", async () => {
    await agent
      .post("/api/bundles")
      .send({ text: file(APP, SAVE) })
      .expect(201);
    const preview = await check(APP.replace("  Disk:", "  Drive:"));
    expect(preview.ok).toBe(false);
    expect(preview.broken.map((p) => p.name)).toEqual(["Disk prices"]);

    // A pipeline alone, against the App I have.
    const alone = await check(READ);
    expect(alone).toMatchObject({ ok: true });
    expect(alone.items.map((i) => [i.kind, i.action])).toEqual([["pipeline", "create"]]);
    const saved = (await agent.post("/api/bundles").send({ text: READ }).expect(201)).body as BundleCheckView;
    const pipeline = (await agent.get(`/api/pipelines/${saved.items[0].id}`).expect(200)).body as PipelineDetailView;
    expect(pipeline.name).toBe("Cheapest disks");
  });
});
