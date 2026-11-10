import { KeyRing, seal } from "@realentity/storm-crypto";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { EMBEDDING_DIMENSIONS, emptyUsage, type Embeddings } from "@realentity/storm-llm";
import { TestEnvironment } from "@realentity/storm-testing";
import { randomBytes, randomUUID } from "node:crypto";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { CredentialVault } from "../src/secrets/credential-vault";
import { GitHubClient } from "../src/sources/github";
import { GitChangesStep, TopicIndexStep, type SourceChange, type SourceRead } from "../src/steps/topic-source-steps";

/** A repository on a stand-in GitHub: commits, each with its files; the head moves as commits are added. */
class FakeGitHub {
  commits: { sha: string; date: string; files: Record<string, string> }[] = [];
  requests: { url: string; authorization: string | undefined }[] = [];

  commit(files: Record<string, string>): string {
    const sha = randomBytes(20).toString("hex");
    this.commits.push({ sha, date: new Date(Date.UTC(2026, 10, this.commits.length + 1)).toISOString(), files });
    return sha;
  }

  fetch: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.requests.push({ url: url.pathname + url.search, authorization: headers.authorization });
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    const at = (sha: string) => this.commits.find((c) => c.sha === sha);
    let m: RegExpExecArray | null;
    if ((m = /^\/repos\/acme\/orion\/commits\/(.+)$/.exec(url.pathname))) {
      const head = this.commits.at(-1)!;
      return json({ sha: head.sha, commit: { committer: { date: head.date } } });
    }
    if ((m = /^\/repos\/acme\/orion\/compare\/(\w+)\.\.\.(\w+)$/.exec(url.pathname))) {
      const [base, head] = [at(m[1]), at(m[2])];
      if (!base || !head) return Promise.resolve(new Response("{}", { status: 404 }));
      const paths = new Set([...Object.keys(base.files), ...Object.keys(head.files)]);
      const files = [...paths].flatMap((filename) =>
        !(filename in head.files)
          ? [{ filename, status: "removed" }]
          : !(filename in base.files)
            ? [{ filename, status: "added" }]
            : base.files[filename] !== head.files[filename]
              ? [{ filename, status: "modified" }]
              : [],
      );
      return json({ files });
    }
    if ((m = /^\/repos\/acme\/orion\/git\/trees\/(\w+)$/.exec(url.pathname))) {
      const files = at(m[1])!.files;
      return json({ tree: Object.entries(files).map(([path, text]) => ({ path, type: "blob", size: text.length })) });
    }
    if ((m = /^\/repos\/acme\/orion\/contents\/(.+)$/.exec(url.pathname))) {
      const text = at(url.searchParams.get("ref")!)!.files[decodeURIComponent(m[1])];
      return Promise.resolve(text === undefined ? new Response("{}", { status: 404 }) : new Response(text, { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
}

/** Embeddings that are the same for the same text. */
const embeddings: Embeddings = {
  model: "test-embeddings",
  embed: (texts) =>
    Promise.resolve({
      vectors: texts.map((t) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => ((t.length * (i + 1)) % 7) / 7)),
      usage: emptyUsage(),
    }),
};

const ADR = (decision: string) => `# ADR-0012: The database\n\nStatus: accepted\n\n## Decision\n\n${decision}\n`;

// M43-T1, T3: a topic's GitHub source, its changes and its passages
describe("git.changes and topic.index", () => {
  let db: PrismaConnection;
  let userId: string;
  let orion: string;
  let source: string;
  let github: FakeGitHub;
  const keys = new KeyRing(new Map([[1, randomBytes(32)]]), 1);

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    github = new FakeGitHub();
    orion = (await db.client.topic.create({ data: { userId, name: "Orion" } })).topicId;
    source = (
      await db.client.topicSource.create({ data: { userId, topicId: orion, kind: "GITHUB", location: "acme/orion", path: "docs/adr/**" } })
    ).topicSourceId;
  });

  afterEach(async () => {
    await db.client.topic.deleteMany();
    await db.client.credential.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const context = (dryRun = false): StepContext => ({
    runId: randomUUID(),
    userId,
    pipelineId: randomUUID(),
    stepId: "s",
    stepKey: "s",
    itemIndex: null,
    dryRun,
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
  });
  const client = () => new GitHubClient(new CredentialVault(db.client, keys), github.fetch);
  const read = async (dryRun = false) => {
    const changed = (await new GitChangesStep(db.client, client()).execute({}, context(dryRun))) as {
      changes: SourceChange[];
      sources: SourceRead[];
      problems: string[];
    };
    const indexed = (await new TopicIndexStep(db.client, client(), embeddings).execute(changed, context(dryRun))) as {
      files: (SourceChange & { text: string })[];
      passages: number;
      removed: number;
      problems: string[];
    };
    return { changed, indexed };
  };
  const passages = async () =>
    (
      await db.client.$queryRaw<{ path: string; ref: string; heading: string; text: string; embedded: boolean }[]>`
        SELECT "path", "ref", "heading", "text", "embedding" IS NOT NULL AS "embedded" FROM "TopicPassages"
        WHERE "topicSourceId" = ${source}::uuid ORDER BY "path", "ordinal"`
    ).map((p) => [p.path, p.ref.slice(0, 7), p.heading, p.text, p.embedded]);

  // M43-I1
  it("the first read indexes every text file under the path; a new commit re-indexes only its changed files there", async () => {
    const first = github.commit({
      "docs/adr/0012-database.md": ADR("PostgreSQL 17."),
      "docs/adr/0013-hosting.md": "# ADR-0013: Hosting\n\nOn the client's cloud.\n",
      "docs/adr/diagram.png": "binary",
      "src/index.ts": "export {};",
    });
    const one = await read();
    expect(one.changed.changes.map((c) => [c.path, c.status])).toEqual([
      ["docs/adr/0012-database.md", "added"],
      ["docs/adr/0013-hosting.md", "added"],
    ]);
    expect(one.changed.sources).toEqual([expect.objectContaining({ from: null, to: first })]);
    expect(await passages()).toEqual([
      ["docs/adr/0012-database.md", first.slice(0, 7), "ADR-0012: The database", "Status: accepted", true],
      ["docs/adr/0012-database.md", first.slice(0, 7), "ADR-0012: The database > Decision", "PostgreSQL 17.", true],
      ["docs/adr/0013-hosting.md", first.slice(0, 7), "ADR-0013: Hosting", "On the client's cloud.", true],
    ]);
    expect((await db.client.topicSource.findUniqueOrThrow({ where: { topicSourceId: source } })).cursor).toBe(first);

    // Nothing new: one call, nothing read.
    github.requests = [];
    const quiet = await read();
    expect(quiet.changed.changes).toEqual([]);
    expect(github.requests.map((r) => r.url)).toEqual(["/repos/acme/orion/commits/HEAD"]);

    // A change outside the path: the source moves on, nothing is indexed.
    const outside = github.commit({ ...github.commits.at(-1)!.files, "src/index.ts": "export const x = 1;" });
    github.requests = [];
    expect((await read()).changed.changes).toEqual([]);
    expect(github.requests.some((r) => r.url.includes("/contents/"))).toBe(false);
    expect((await db.client.topicSource.findUniqueOrThrow({ where: { topicSourceId: source } })).cursor).toBe(outside);

    // ADR-0012 changed, ADR-0013 removed: only those.
    const files = { ...github.commits.at(-1)!.files, "docs/adr/0012-database.md": ADR("MySQL 8, after the load tests.") };
    delete (files as Record<string, string>)["docs/adr/0013-hosting.md"];
    const second = github.commit(files);
    github.requests = [];
    const two = await read();
    expect(two.changed.changes.map((c) => [c.path, c.status])).toEqual([
      ["docs/adr/0012-database.md", "modified"],
      ["docs/adr/0013-hosting.md", "removed"],
    ]);
    expect(github.requests.filter((r) => r.url.includes("/contents/")).map((r) => r.url)).toEqual([
      `/repos/acme/orion/contents/docs/adr/0012-database.md?ref=${second}`,
    ]);
    expect(two.indexed.files.find((f) => f.status === "modified")?.text).toContain("MySQL 8");
    expect(await passages()).toEqual([
      ["docs/adr/0012-database.md", second.slice(0, 7), "ADR-0012: The database", "Status: accepted", true],
      ["docs/adr/0012-database.md", second.slice(0, 7), "ADR-0012: The database > Decision", "MySQL 8, after the load tests.", true],
    ]);
  });

  // M43-I2
  it("the index deleted and rebuilt gives the same passages; a dry run writes nothing", async () => {
    github.commit({ "docs/adr/0012-database.md": ADR("PostgreSQL 17."), "docs/adr/0013-hosting.md": "# Hosting\n\nCloud.\n" });
    const dry = await read(true);
    expect(dry.indexed.files.map((f) => f.path)).toEqual(["docs/adr/0012-database.md", "docs/adr/0013-hosting.md"]);
    expect(await passages()).toEqual([]);
    expect((await db.client.topicSource.findUniqueOrThrow({ where: { topicSourceId: source } })).cursor).toBeNull();

    await read();
    const before = await passages();
    // Rebuild: the cache and the position go; the next read makes them again.
    await db.client.topicPassage.deleteMany({ where: { topicSourceId: source } });
    await db.client.topicSource.update({ where: { topicSourceId: source }, data: { cursor: null } });
    await read();
    expect(await passages()).toEqual(before);
  });

  // M43-S1 (the token's part)
  it("a private repository's token goes to api.github.com only, and never into an error", async () => {
    github.commit({ "docs/adr/0001.md": "# One\n\nText.\n" });
    const credential = async (name: string, allowedHosts: string[]) => {
      const credentialId = randomUUID();
      await db.client.credential.create({
        data: {
          credentialId,
          userId,
          name,
          allowedHosts,
          kind: "API_KEY",
          username: "",
          ...seal(keys, credentialId, `ghp_${name}SecretToken0123456789`),
        },
      });
    };
    await credential("orion-repo", ["api.github.com"]);
    await credential("elsewhere", ["git.example.com"]);

    await db.client.topicSource.update({ where: { topicSourceId: source }, data: { credential: "orion-repo" } });
    await read();
    expect(github.requests.every((r) => r.authorization === "Bearer ghp_orion-repoSecretToken0123456789")).toBe(true);

    await db.client.topicSource.update({ where: { topicSourceId: source }, data: { credential: "elsewhere", cursor: null } });
    github.requests = [];
    const refused = await read();
    expect(github.requests).toEqual([]);
    expect(refused.changed.problems).toHaveLength(1);
    expect(refused.changed.problems[0]).toContain("Orion, acme/orion");
    expect(JSON.stringify(refused)).not.toContain("SecretToken");
  });
});
