import { KeyRing, open } from "@realentity/storm-crypto";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type CredentialView } from "@realentity/storm-shared";
import { randomUUID } from "node:crypto";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const ENCRYPTED_FIELDS = ["ciphertext", "iv", "authTag", "wrappedDek", "secret"];

/** M1-S4: a response body never carries the value or any encrypted part. */
function expectNoSecret(body: unknown, secret: string): void {
  const text = JSON.stringify(body ?? null);
  expect(text).not.toContain(secret);
  expect(text).not.toContain(Buffer.from(secret).toString("base64"));
  for (const field of ENCRYPTED_FIELDS) {
    expect(text).not.toContain(`"${field}"`);
  }
}

describe("credentials", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterAll(async () => {
    await db.client.credential.deleteMany();
    await db.close();
    await api.close();
  });

  it("creates, lists, replaces and deletes without ever returning the value", async () => {
    const secret = `pw-${randomUUID()}`;
    const created = await agent
      .post("/api/credentials")
      .send({ name: "linkedin", allowedHosts: ["linkedin.com", "*.linkedin.com"], username: "me@example.com", kind: "PASSWORD", secret })
      .expect(201);
    expectNoSecret(created.body, secret);
    const view = created.body as CredentialView;
    expect(view).toMatchObject({ name: "linkedin", allowedHosts: ["linkedin.com", "*.linkedin.com"], kind: "PASSWORD", keyVersion: 1 });

    const listed = await agent.get("/api/credentials").expect(200);
    expectNoSecret(listed.body, secret);
    expect(listed.body).toHaveLength(1);

    const newSecret = `pw2-${randomUUID()}`;
    const replaced = await agent.put(`/api/credentials/${view.credentialId}/secret`).send({ secret: newSecret }).expect(200);
    expectNoSecret(replaced.body, secret);
    expectNoSecret(replaced.body, newSecret);

    const row = await db.client.credential.findUniqueOrThrow({ where: { credentialId: view.credentialId } });
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain(newSecret);
    // The api sealed it with the root key from the environment; only a holder of that key (the worker) can open it.
    expect(open(KeyRing.fromEnv(process.env), row.credentialId, row)).toBe(newSecret);

    await agent.delete(`/api/credentials/${view.credentialId}`).expect(204);
    await agent.get("/api/credentials").expect(200, []);
  });

  it("rejects a duplicate name", async () => {
    const body = { name: "dup", allowedHosts: ["example.com"], kind: "API_KEY", secret: "k" };
    await agent.post("/api/credentials").send(body).expect(201);
    const conflict = await agent.post("/api/credentials").send(body).expect(409);
    expectNoSecret(conflict.body, "k-never-echoed");
  });

  it("does not echo the value in validation errors", async () => {
    const secret = `leak-${randomUUID()}`;
    const response = await agent
      .post("/api/credentials")
      .send({ name: "bad", allowedHosts: ["https://evil.com/x"], kind: "PASSWORD", secret })
      .expect(400);
    expectNoSecret(response.body, secret);
  });

  it("M29-T7: a database credential is a postgresql:// URL whose host is among its allowed hosts; never echoed", async () => {
    const password = `pw-${randomUUID()}`;
    const database = (secret: string, allowedHosts: string[]) => agent.post("/api/credentials").send({ name: `db-${randomUUID().slice(0, 8)}`, kind: "DATABASE", allowedHosts, secret });
    await database(`postgresql://reader:${password}@postgres:5432/app`, ["postgres"]).expect(201);
    await database(`postgres://reader:${password}@100.101.102.103/app`, ["100.101.102.103"]).expect(201);
    const elsewhere = await database(`postgresql://reader:${password}@db.example.com/app`, ["postgres"]).expect(400);
    expect(JSON.stringify(elsewhere.body)).toContain("the database's host (db.example.com) must be one of its allowed hosts");
    expectNoSecret(elsewhere.body, password);
    const notUrl = await database(`host=postgres password=${password}`, ["postgres"]).expect(400);
    expect(JSON.stringify(notUrl.body)).toContain("the connection string must be a URL");
    expectNoSecret(notUrl.body, password);

    // Replacing it: still a connection string, still on its host.
    const stored = (await database(`postgresql://reader:${password}@postgres:5432/app`, ["postgres"]).expect(201)).body as { credentialId: string };
    const replace = (secret: string) => agent.put(`/api/credentials/${stored.credentialId}/secret`).send({ secret });
    await replace(`postgresql://reader:new-${password}@postgres:5432/app`).expect(200);
    const moved = await replace(`postgresql://reader:${password}@db.example.com/app`).expect(400);
    expect(JSON.stringify(moved.body)).toContain("the database's host (db.example.com) must be one of its allowed hosts");
    expectNoSecret(moved.body, password);
    await replace("not a url").expect(400);
  });

  it("does not touch another user's credentials", async () => {
    const other = await db.client.user.create({ data: { email: `other-${randomUUID()}@storm.test` } });
    const credentialId = randomUUID();
    await db.client.credential.create({
      data: {
        credentialId,
        userId: other.userId,
        name: "theirs",
        allowedHosts: ["example.com"],
        kind: "PASSWORD",
        ciphertext: Buffer.alloc(1),
        iv: Buffer.alloc(12),
        authTag: Buffer.alloc(16),
        wrappedDek: Buffer.alloc(60),
      },
    });

    await agent.put(`/api/credentials/${credentialId}/secret`).send({ secret: "x" }).expect(404);
    await agent.delete(`/api/credentials/${credentialId}`).expect(404);
    const listed = await agent.get("/api/credentials").expect(200);
    expect((listed.body as CredentialView[]).map((c) => c.name)).not.toContain("theirs");

    await db.client.user.delete({ where: { userId: other.userId } });
  });
});
