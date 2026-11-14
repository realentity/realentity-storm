import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type BindingView, type EmailAccountView, type PipelineDetailView } from "@realentity/storm-shared";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const READER = `
name: Work mail
steps:
  - id: fetch
    type: email.fetch
    with: { account: work }
`;

// M50-T7: several email accounts, one the default; the password sealed, never returned; an email slot filled by id
describe("email accounts", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterEach(async () => {
    await db.client.pipeline.deleteMany();
    await db.client.emailAccount.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const add = async (address: string, extra: Record<string, unknown> = {}) =>
    (
      await agent
        .post("/api/email-accounts")
        .send({ address, imapHost: "imap.example.com", smtpHost: "smtp.example.com", password: "app-password-Q7", ...extra })
        .expect(201)
    ).body as EmailAccountView;
  const list = async () => (await agent.get("/api/email-accounts").expect(200)).body as EmailAccountView[];

  it("the first is the default; another can become it; removing the default makes the next one it", async () => {
    const home = await add("Me@Example.com");
    expect(home).toMatchObject({ address: "me@example.com", isDefault: true, imapPort: 993, smtpPort: 465, tls: true, usedBy: [] });
    expect(JSON.stringify(home)).not.toContain("app-password-Q7");
    const work = await add("me@work.example", { label: "Work" });
    expect(work.isDefault).toBe(false);
    // The same address twice: refused.
    await agent
      .post("/api/email-accounts")
      .send({ address: "me@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com", password: "x" })
      .expect(409);

    await agent.patch(`/api/email-accounts/${work.emailAccountId}`).send({ isDefault: true }).expect(200);
    expect((await list()).map((a) => [a.address, a.isDefault])).toEqual([
      ["me@work.example", true],
      ["me@example.com", false],
    ]);
    // Stored sealed: the row has no plain password.
    const row = await db.client.emailAccount.findUniqueOrThrow({ where: { emailAccountId: work.emailAccountId } });
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain("app-password-Q7");

    await agent.delete(`/api/email-accounts/${work.emailAccountId}`).expect(204);
    expect((await list()).map((a) => [a.address, a.isDefault])).toEqual([["me@example.com", true]]);
  });

  it("TLS off only for a server on this machine", async () => {
    const plain = { address: "me@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com", password: "x", tls: false };
    const refused = await agent.post("/api/email-accounts").send(plain).expect(400);
    expect(JSON.stringify(refused.body)).toContain("TLS can be off only");
    await agent
      .post("/api/email-accounts")
      .send({ ...plain, imapHost: "localhost", smtpHost: "127.0.0.1" })
      .expect(201);
  });

  it("an email slot: offered the user's accounts, filled by id, the default until then; never empty; a credential refused", async () => {
    const home = await add("me@example.com");
    const work = await add("me@work.example");
    const pipeline = (await agent.post("/api/pipelines").send({ source: READER }).expect(201)).body as PipelineDetailView;
    const bindings = `/api/pipelines/${pipeline.pipelineId}/bindings`;

    const [slot] = (await agent.get(bindings).expect(200)).body as BindingView[];
    expect(slot).toMatchObject({ slot: "work", need: { kind: "email" }, account: null });
    expect(slot?.fits.map((f) => f.name)).toEqual(["me@example.com", "me@work.example"]);
    // Not filled is fine (the default account): it can be switched on.
    await agent.patch(`/api/pipelines/${pipeline.pipelineId}`).send({ enabled: true }).expect(200);

    const [filled] = (
      await agent
        .put(bindings)
        .send({ work: { emailAccountId: work.emailAccountId } })
        .expect(200)
    ).body as BindingView[];
    expect(filled?.account).toEqual({ emailAccountId: work.emailAccountId, address: "me@work.example" });
    expect((await list()).find((a) => a.address === "me@work.example")?.usedBy).toEqual([
      { owner: "pipeline", id: pipeline.pipelineId, name: "Work mail", slot: "work" },
    ]);
    await agent
      .put(bindings)
      .send({ work: { credentialId: home.emailAccountId } })
      .expect(400);
    await agent
      .put(bindings)
      .send({ work: { emailAccountId: "00000000-0000-4000-8000-000000000000" } })
      .expect(400);

    // Removing the account clears the slot: back to the default.
    await agent.delete(`/api/email-accounts/${work.emailAccountId}`).expect(204);
    expect(((await agent.get(bindings).expect(200)).body as BindingView[])[0]?.account).toBeNull();
  });
});
