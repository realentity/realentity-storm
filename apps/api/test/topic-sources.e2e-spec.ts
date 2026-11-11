import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type TopicSourceView, type TopicView } from "@realentity/storm-shared";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

// M43: a topic's sources, linked and never copied; the index a cache that Rebuild deletes
describe("topic sources", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterEach(async () => {
    await db.client.topic.deleteMany();
    await db.client.credential.deleteMany();
    await db.client.googleConnection.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const credential = (name: string, allowedHosts: string[]) =>
    agent.post("/api/credentials").send({ name, kind: "API_KEY", secret: "test-token-value", allowedHosts }).expect(201);

  // M43-T2
  it("a Drive folder added from its link, once Google is connected: no branch, no token, its link kept", async () => {
    const { topicId } = (await agent.post("/api/topics").send({ name: "Orion" }).expect(201)).body as TopicView;
    const folder = "1AbCdEfGhIjKlMnOpQrStUv";
    const add = (location: string) =>
      agent.post(`/api/topics/${topicId}/sources`).send({ kind: "DRIVE", location, credential: "orion-repo" });

    expect((await add(`https://drive.google.com/drive/folders/${folder}`).expect(400)).body).toMatchObject({
      message: expect.stringContaining("Connect Google in Settings first") as unknown,
    });
    const { userId } = await db.client.user.findFirstOrThrow();
    const sealed = { ciphertext: Buffer.from("x"), iv: Buffer.from("x"), authTag: Buffer.from("x"), wrappedDek: Buffer.from("x") };
    await db.client.googleConnection.create({
      data: { userId, email: "ana@gmail.test", scopes: ["https://www.googleapis.com/auth/drive.readonly"], ...sealed },
    });

    await add("https://drive.google.com/file/d/abc/view").expect(400);
    const source = (await add(`https://drive.google.com/drive/u/0/folders/${folder}?usp=sharing`).expect(201)).body as TopicSourceView;
    expect(source).toMatchObject({
      kind: "DRIVE",
      location: folder,
      path: "**",
      branch: null,
      credential: null,
      cursor: null,
      url: `https://drive.google.com/drive/folders/${folder}`,
    });
    await add(folder).expect(409);

    // Read once: its page token isn't shown, only that it was read.
    await db.client.topicSource.update({
      where: { topicSourceId: source.topicSourceId },
      data: { cursor: "48213", readAt: new Date(), title: "Orion" },
    });
    expect((await agent.get(`/api/topics/${topicId}/sources`).expect(200)).body).toEqual([
      expect.objectContaining({ cursor: "read", title: "Orion" }),
    ]);
  });

  it("a repository added (from its address), its token checked for api.github.com, rebuilt and removed", async () => {
    const { topicId } = (await agent.post("/api/topics").send({ name: "Orion" }).expect(201)).body as TopicView;
    const add = (body: Record<string, unknown>) => agent.post(`/api/topics/${topicId}/sources`).send({ kind: "GITHUB", ...body });

    const source = (await add({ location: "https://github.com/acme/orion", path: "docs/adr/**", branch: "" }).expect(201))
      .body as TopicSourceView;
    expect(source).toMatchObject({
      location: "acme/orion",
      path: "docs/adr/**",
      branch: null,
      credential: null,
      cursor: null,
      passages: 0,
      url: "https://github.com/acme/orion/tree/HEAD/docs/adr",
    });
    await add({ location: "acme/orion", path: "docs/adr/**" }).expect(409);
    await add({ location: "not a repository" }).expect(400);

    await credential("elsewhere", ["git.example.com"]);
    await credential("orion-repo", ["api.github.com"]);
    expect((await add({ location: "acme/orion-private", credential: "missing" }).expect(400)).body).toMatchObject({
      message: 'There is no credential "missing"',
    });
    await add({ location: "acme/orion-private", credential: "elsewhere" }).expect(400);
    await add({ location: "acme/orion-private", credential: "orion-repo" }).expect(201);

    // Read once: rebuild forgets where it read to, and its passages.
    await db.client.topicSource.update({
      where: { topicSourceId: source.topicSourceId },
      data: { cursor: "a1b2c3d4e5", readAt: new Date() },
    });
    await db.client.topicPassage.create({
      data: {
        userId: (await db.client.topic.findUniqueOrThrow({ where: { topicId } })).userId,
        topicId,
        topicSourceId: source.topicSourceId,
        path: "docs/adr/0001.md",
        ref: "a1b2c3d4e5",
        refDate: new Date(),
        ordinal: 0,
        text: "PostgreSQL.",
      },
    });
    const listed = (await agent.get(`/api/topics/${topicId}/sources`).expect(200)).body as TopicSourceView[];
    expect(listed.map((s) => [s.location, s.cursor, s.passages])).toEqual([
      ["acme/orion", "a1b2c3d", 1],
      ["acme/orion-private", null, 0],
    ]);
    const rebuilt = (await agent.post(`/api/topic-sources/${source.topicSourceId}/rebuild`).expect(200)).body as TopicSourceView;
    expect(rebuilt).toMatchObject({ cursor: null, readAt: null, passages: 0 });
    expect(await db.client.topicPassage.count()).toBe(0);

    await agent.delete(`/api/topic-sources/${source.topicSourceId}`).expect(204);
    expect(((await agent.get(`/api/topics/${topicId}/sources`).expect(200)).body as TopicSourceView[]).map((s) => s.location)).toEqual([
      "acme/orion-private",
    ]);
  });
});
