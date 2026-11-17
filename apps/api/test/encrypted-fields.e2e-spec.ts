import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { QUEUES } from "@realentity/storm-queue";
import { isSealed, sealedAt, type AppDetailView, type AppEntityView } from "@realentity/storm-shared";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const APP = (valueField: string) => `
name: Deploy
types:
  Secret:
    key: name
    fields:
      name: { type: text, required: true }
      value: ${valueField}
      note: { type: text, mine: true }
pages:
  - list: Secret
    add: true
  - form: Secret
    fields: [value, note]
`;
const ENCRYPTED = APP("{ type: text, mine: true, encrypted: true }");
const PLAIN = APP("{ type: text, mine: true }");

// M52-I1 (the api's part), T3, T4: the form seals an encrypted field, no answer carries it, versions seal or refuse
describe("encrypted fields on an App's pages", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const create = async (source: string) => ((await agent.post("/api/apps").send({ source }).expect(201)).body as AppDetailView).appId;
  const row = (appId: string, key: string) =>
    db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type: "Secret", key } } });

  it("seals what the form sets and answers only that it is set", async () => {
    const appId = await create(ENCRYPTED);
    await agent
      .post(`/api/apps/${appId}/pages/Secret`)
      .send({ values: { name: "API_TOKEN", value: "s3cret-token", note: "deploy" } })
      .expect(201);
    const stored = await row(appId, "API_TOKEN");
    expect(JSON.stringify(stored)).not.toContain("s3cret-token");
    const sealed = (stored.mine as Record<string, unknown>).value;
    expect(isSealed(sealed) && sealed.$sealed.at).toBe(sealedAt(appId, "Secret", "API_TOKEN", "value"));

    const page = (await agent.get(`/api/apps/${appId}/pages/Secret/API_TOKEN`).expect(200)).body as AppEntityView;
    expect(page.mine).toEqual({ value: "***", note: "deploy" });
    expect(page.row.value.value).toBe("***");
    expect(page.page.form).toContainEqual(expect.objectContaining({ field: "value", encrypted: true }));
    const list = await agent.get(`/api/apps/${appId}/types/Secret/entities`).expect(200);
    expect(JSON.stringify(list.body)).not.toContain("ciphertext");
    // entity.changed carries the sealed value, never the text.
    const events = await db.client.$queryRaw<{ data: unknown }[]>`SELECT data FROM pgboss.job`;
    expect(JSON.stringify(events)).not.toContain("s3cret-token");
  });

  it("replaces it, tells a change only when it differs, and clears it", async () => {
    const appId = await create(ENCRYPTED);
    await agent
      .post(`/api/apps/${appId}/pages/Secret`)
      .send({ values: { name: "API_TOKEN", value: "one" } })
      .expect(201);
    const url = `/api/apps/${appId}/pages/Secret/API_TOKEN/values`;
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
    await agent
      .put(url)
      .send({ values: { value: "one" } })
      .expect(200);
    expect(await db.client.$queryRaw<unknown[]>`SELECT 1 FROM pgboss.job WHERE name = ${QUEUES.events}`).toEqual([]);
    await agent
      .put(url)
      .send({ values: { value: "two" } })
      .expect(200);
    expect(await db.client.$queryRaw<unknown[]>`SELECT 1 FROM pgboss.job WHERE name = ${QUEUES.events}`).toHaveLength(1);
    const cleared = (
      await agent
        .put(url)
        .send({ values: { value: null } })
        .expect(200)
    ).body as AppEntityView;
    expect(cleared.mine).toEqual({});
  });

  it("seals the values a field holds when a version makes it encrypted, and refuses to stop while it holds any", async () => {
    const appId = await create(PLAIN);
    await agent
      .post(`/api/apps/${appId}/pages/Secret`)
      .send({ values: { name: "API_TOKEN", value: "was-plain" } })
      .expect(201);
    await agent.put(`/api/apps/${appId}`).send({ source: ENCRYPTED }).expect(200);
    const stored = await row(appId, "API_TOKEN");
    expect(JSON.stringify(stored)).not.toContain("was-plain");
    expect(isSealed((stored.mine as Record<string, unknown>).value)).toBe(true);

    const refused = await agent.put(`/api/apps/${appId}`).send({ source: PLAIN }).expect(409);
    expect((refused.body as { message: string }).message).toBe(
      "Secret.value holds an encrypted value: clear it first, or remove the field, to keep it unencrypted",
    );
    await agent
      .put(`/api/apps/${appId}/pages/Secret/API_TOKEN/values`)
      .send({ values: { value: null } })
      .expect(200);
    await agent.put(`/api/apps/${appId}`).send({ source: PLAIN }).expect(200);
  });
});
