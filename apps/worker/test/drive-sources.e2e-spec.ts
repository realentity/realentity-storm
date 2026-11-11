import { KeyRing, seal } from "@realentity/storm-crypto";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { GOOGLE_TOKEN_URL } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { randomBytes, randomUUID } from "node:crypto";
import { GoogleConnection } from "../src/google/google-connection";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { DriveClient } from "../src/sources/drive";
import { GitHubClient } from "../src/sources/github";
import { DriveChangesStep, TopicIndexStep, type SourceChange, type SourceRead } from "../src/steps/topic-source-steps";

const DRIVE = "https://drive.test/drive/v3";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const FOLDER = "application/vnd.google-apps.folder";
const DOC = "application/vnd.google-apps.document";

interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  version: string;
  modifiedTime: string;
  content: string;
}

/**
 * Google, as far as Drive sources use it: the token endpoint, and a Drive whose every change (a new file, an edit, a
 * move, the bin) is a numbered entry of its changes list. Docs are exported as Markdown, other files downloaded.
 */
class FakeDrive {
  files = new Map<string, StoredFile>();
  log: string[] = [];
  requests: string[] = [];
  /** What the token endpoint says the refresh grants. */
  scopes = [CALENDAR_SCOPE, DRIVE_SCOPE];

  put(file: Partial<StoredFile> & { name: string }): string {
    const id = file.id ?? `f${randomBytes(8).toString("hex")}`;
    const before = this.files.get(id);
    const version = String(Number(before?.version ?? 0) + 1);
    this.files.set(id, {
      mimeType: "text/plain",
      parents: [],
      trashed: false,
      content: "",
      ...before,
      ...file,
      id,
      version,
      modifiedTime: new Date(Date.UTC(2026, 10, 1, this.log.length)).toISOString(),
    });
    this.log.push(id);
    return id;
  }

  fetch: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (url.href === GOOGLE_TOKEN_URL) return json({ access_token: "access-1", expires_in: 3599, scope: this.scopes.join(" ") });
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer access-1");
    const path = url.pathname.replace(/^\/drive\/v3/, "");
    this.requests.push(path + (url.searchParams.get("q") ? ` ${url.searchParams.get("q")}` : ""));
    const view = ({ content: _content, ...file }: StoredFile) => file;
    if (path === "/changes/startPageToken") return json({ startPageToken: String(this.log.length) });
    if (path === "/changes") {
      const since = Number(url.searchParams.get("pageToken"));
      const ids = [...new Set(this.log.slice(since))];
      return json({
        changes: ids.map((fileId) => ({ fileId, removed: false, file: view(this.files.get(fileId)!) })),
        newStartPageToken: String(this.log.length),
      });
    }
    if (path === "/files") {
      const parent = /^'([^']+)' in parents and trashed = false$/.exec(url.searchParams.get("q") ?? "")![1];
      return json({ files: [...this.files.values()].filter((f) => f.parents.includes(parent) && !f.trashed).map(view) });
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/files\/([^/]+)\/export$/.exec(path))) {
      expect(url.searchParams.get("mimeType")).toBe("text/markdown");
      return Promise.resolve(new Response(this.files.get(m[1])!.content));
    }
    if ((m = /^\/files\/([^/]+)$/.exec(path))) {
      const file = this.files.get(decodeURIComponent(m[1]));
      if (!file) return json({ error: { message: "File not found" } }, 404);
      return url.searchParams.get("alt") === "media" ? Promise.resolve(new Response(file.content)) : json(view(file));
    }
    return json({ error: { message: "Not found" } }, 404);
  };
}

// M43-T2: a topic's Google Drive folder, its changes and its passages
describe("drive.changes and topic.index", () => {
  let db: PrismaConnection;
  let userId: string;
  let orion: string;
  let source: string;
  let drive: FakeDrive;
  let folder: string;
  const keys = new KeyRing(new Map([[1, randomBytes(32)]]), 1);

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  const connect = async (scopes: string[]) => {
    const data = { email: "ana@gmail.test", scopes, ...seal(keys, userId, "refresh-1") };
    await db.client.googleConnection.upsert({
      where: { userId },
      create: { userId, ...data },
      update: { ...data, status: "CONNECTED", brokenAt: null },
    });
  };

  beforeEach(async () => {
    drive = new FakeDrive();
    folder = drive.put({ name: "Orion", mimeType: FOLDER });
    await connect(["openid", "email", CALENDAR_SCOPE, DRIVE_SCOPE]);
    orion = (await db.client.topic.create({ data: { userId, name: "Orion" } })).topicId;
    source = (await db.client.topicSource.create({ data: { userId, topicId: orion, kind: "DRIVE", location: folder } })).topicSourceId;
  });

  afterEach(async () => {
    await db.client.topic.deleteMany();
    await db.client.googleConnection.deleteMany();
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
  const client = () =>
    new DriveClient(
      new GoogleConnection(db.client, keys, {
        clientId: "client.apps.googleusercontent.com",
        clientSecret: "secret-123456",
        fetch: drive.fetch,
        driveBase: DRIVE,
      }),
    );
  const read = async () => {
    const changed = (await new DriveChangesStep(db.client, client()).execute({}, context())) as {
      changes: SourceChange[];
      sources: SourceRead[];
      problems: string[];
    };
    // As the shipped pipeline gives them: git.changes' list and drive.changes' list.
    const indexed = (await new TopicIndexStep(db.client, new GitHubClient(undefined), null, client()).execute(
      { changes: [[], changed.changes], sources: [[], changed.sources] },
      context(),
    )) as { files: (SourceChange & { text: string })[]; passages: number; removed: number; problems: string[] };
    return { changed, indexed };
  };
  const passages = async () =>
    (await db.client.topicPassage.findMany({ where: { topicSourceId: source }, orderBy: [{ path: "asc" }, { ordinal: "asc" }] })).map(
      (p) => [p.path, p.heading, p.text, p.ref],
    );

  // M43-I3
  it("the first read indexes the folder and its subfolders; then Drive's changes: an edit, a move out, the bin", async () => {
    const kickoff = drive.put({ name: "Kickoff", mimeType: DOC, parents: [folder], content: "# Kickoff\n\nLaunch in March.\n" });
    const specs = drive.put({ name: "Specs", mimeType: FOLDER, parents: [folder] });
    const api = drive.put({ name: "api.md", parents: [specs], content: "# API\n\nREST, versioned.\n" });
    drive.put({ name: "logo.png", mimeType: "image/png", parents: [folder], content: "binary" });
    const elsewhere = drive.put({ name: "Elsewhere", mimeType: FOLDER });
    drive.put({ name: "notes.md", parents: [elsewhere], content: "# Not Orion\n" });

    const one = await read();
    expect(one.changed.problems).toEqual([]);
    expect(one.changed.changes.map((c) => [c.path, c.status])).toEqual([
      ["Kickoff", "added"],
      ["Specs/api.md", "added"],
    ]);
    expect(await passages()).toEqual([
      ["Kickoff", "Kickoff", "Launch in March.", "1"],
      ["Specs/api.md", "API", "REST, versioned.", "1"],
    ]);
    const after = await db.client.topicSource.findUniqueOrThrow({ where: { topicSourceId: source } });
    expect(after).toMatchObject({ title: "Orion", cursor: String(drive.log.length) });

    // Nothing new: one call to the changes list.
    drive.requests = [];
    expect((await read()).changed.changes).toEqual([]);
    expect(drive.requests).toEqual(["/changes"]);

    // Kickoff edited, api.md moved out, a file elsewhere added, a file starred (same version): only the first two count.
    drive.put({ id: kickoff, name: "Kickoff", content: "# Kickoff\n\nLaunch in April, after the audit.\n" });
    drive.put({ id: api, name: "api.md", parents: [elsewhere] });
    drive.put({ name: "other.md", parents: [elsewhere], content: "# Other\n" });
    drive.log.push(kickoff);
    drive.requests = [];
    const two = await read();
    expect(two.changed.changes.map((c) => [c.path, c.status])).toEqual([
      ["Kickoff", "modified"],
      ["Specs/api.md", "removed"],
    ]);
    expect(two.indexed.files.find((f) => f.status === "modified")?.text).toContain("April");
    expect(await passages()).toEqual([["Kickoff", "Kickoff", "Launch in April, after the audit.", "2"]]);
    expect(drive.requests.filter((r) => r.includes("/export"))).toEqual([`/files/${kickoff}/export`]);

    // Renamed into a subfolder, then binned.
    drive.put({ id: kickoff, name: "Kickoff (final)", parents: [specs] });
    expect((await read()).changed.changes.map((c) => [c.path, c.status])).toEqual([["Specs/Kickoff (final)", "modified"]]);
    expect((await passages()).map((p) => p[0])).toEqual(["Specs/Kickoff (final)"]);
    drive.put({ id: kickoff, name: "Kickoff (final)", trashed: true });
    expect((await read()).changed.changes.map((c) => [c.path, c.status])).toEqual([["Specs/Kickoff (final)", "removed"]]);
    expect(await passages()).toEqual([]);
  });

  // M43-I4
  it("Drive not allowed at the sign-in: the source says so, nothing is read, the connection still works", async () => {
    await connect(["openid", "email", CALENDAR_SCOPE]);
    drive.scopes = [CALENDAR_SCOPE];
    const { changed } = await read();
    expect(changed.problems).toEqual([expect.stringContaining("doesn't include Google Drive: reconnect Google in Settings")]);
    expect(drive.requests).toEqual([]);
    expect(await db.client.googleConnection.findUniqueOrThrow({ where: { userId } })).toMatchObject({ status: "CONNECTED" });
    expect((await db.client.topicSource.findUniqueOrThrow({ where: { topicSourceId: source } })).cursor).toBeNull();
  });

  it("a link to a file, not a folder, is a problem of that source", async () => {
    const doc = drive.put({ name: "Kickoff", mimeType: DOC, content: "# Kickoff\n" });
    await db.client.topicSource.update({ where: { topicSourceId: source }, data: { location: doc } });
    expect((await read()).changed.problems).toEqual([expect.stringContaining('"Kickoff" is not a folder')]);
  });
});
