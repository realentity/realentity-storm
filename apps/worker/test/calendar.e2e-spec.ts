import { KeyRing, payloadHash, seal } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection, type Proposal } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type StructuredRequest } from "@realentity/storm-llm";
import { type LaterJob } from "@realentity/storm-queue";
import { GOOGLE_TOKEN_URL } from "@realentity/storm-shared";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { type z } from "zod";
import { GoogleConnection } from "../src/google/google-connection";
import { LaterStarts } from "../src/runner/later";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { RunControls } from "../src/runner/run-controls";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { TakeoverDesk } from "../src/runner/takeovers";
import { Triggers } from "../src/runner/triggers";
import { CalendarCreateStep, CalendarFindStep } from "../src/steps/calendar-steps";
import { FlowCancelStep, FlowLaterStep } from "../src/steps/flow-steps";
import { ExtractStep } from "../src/steps/llm-steps";
import { Counting, createVersion } from "./support/test-steps";

const API = "https://calendar.test/v3";

interface StoredEvent {
  id: string;
  summary: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  description?: string;
  location?: string;
  attendees?: { email: string }[];
  htmlLink: string;
}

/** Google, as far as Storm uses it: the token endpoint and the primary calendar's events. */
class FakeGoogle {
  events: StoredEvent[] = [];
  inserts: { query: URLSearchParams; body: Record<string, unknown> }[] = [];
  refreshes = 0;
  /** The token endpoint's error, e.g. invalid_grant (a revoked refresh token). */
  tokenError: string | null = null;

  fetch = async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> => {
    const url = new URL(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.href === GOOGLE_TOKEN_URL) {
      this.refreshes++;
      const form = new URLSearchParams(init?.body);
      if (this.tokenError) return json(400, { error: this.tokenError, error_description: "Token has been expired or revoked." });
      expect(form.get("refresh_token")).toBe("refresh-1");
      return json(200, { access_token: `access-${this.refreshes}`, expires_in: 3599, token_type: "Bearer" });
    }
    if (!new Headers(init?.headers).get("authorization")?.startsWith("Bearer access-")) return json(401, { error: { message: "Invalid Credentials" } });
    const path = url.pathname.replace(/^\/v3/, "");
    if (path === "/calendars/primary/events" && init?.method === "GET") {
      const from = new Date(url.searchParams.get("timeMin")!).getTime();
      const to = new Date(url.searchParams.get("timeMax")!).getTime();
      const q = url.searchParams.get("q");
      const items = this.events.filter(
        (e) =>
          new Date(e.start.dateTime).getTime() < to &&
          new Date(e.end.dateTime).getTime() > from &&
          (!q || e.summary.toLowerCase().includes(q.toLowerCase())),
      );
      return json(200, { items });
    }
    if (path === "/calendars/primary/events" && init?.method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as StoredEvent & Record<string, unknown>;
      this.inserts.push({ query: url.searchParams, body });
      if (this.events.some((e) => e.id === body.id)) return json(409, { error: { message: "The requested identifier already exists." } });
      const event = { ...body, htmlLink: `https://calendar.google.com/event?eid=${body.id}` };
      this.events.push(event);
      return json(200, event);
    }
    const one = /^\/calendars\/primary\/events\/(.+)$/.exec(path);
    if (one) return json(200, this.events.find((e) => e.id === one[1]));
    return json(404, { error: { message: "Not found" } });
  };
}

/** The LLM reading an invite: answers what it was told to, and keeps the prompts. */
class Reader implements LlmClient {
  prompts: string[] = [];
  constructor(private readonly values: Record<string, string>) {}
  structured<S extends z.ZodObject>(request: StructuredRequest<S>) {
    this.prompts.push(request.prompt);
    const answer = { values: Object.entries(this.values).map(([name, value]) => ({ name, value })) };
    return Promise.resolve({ output: request.schema.parse(answer), usage: { ...emptyUsage(), calls: 1, costUsd: 0.002 } });
  }
}

const INVITE = `From: Maria Ivanova <maria@acme.test>
Date: Mon, 9 Nov 2026 14:12:00 +0200
Subject: Interview for the .NET Lead role

Hi Ana, thanks for applying. Could we meet on Thursday, 12 November at 10:00 Sofia time, for about an hour?
We'll call you on https://meet.google.com/abc-defg-hij. Best, Maria (Acme)`;

const EVENT = (extra = "") => `
name: Interview event
steps:
  - id: invite
    type: llm.extract
    with:
      content: |
${INVITE.split("\n").map((line) => `        ${line}`).join("\n")}
      fields: { start: when it starts, company: the company, place: the video link }
  - id: event
    type: calendar.create
    when: "{{invite.values.start}}"
    with:
      title: "Interview: {{invite.values.company}}"
      start: "{{invite.values.start}}"
      location: "{{invite.values.place}}"
${extra}`;

// M14: Google Calendar (calendar.find, calendar.create behind its gate, the reconnect wait) and flow.later.
describe("M14: calendar and later starts", () => {
  let db: PrismaConnection;
  let userId: string;
  let keys: KeyRing;
  let google: FakeGoogle;
  let telegram: string[];
  let runner: PipelineRunner;
  let connection: GoogleConnection;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    keys = KeyRing.fromEnv(process.env);
  });

  const connect = async () => {
    const data = { email: "ana@gmail.test", scopes: ["https://www.googleapis.com/auth/calendar.events"], ...seal(keys, userId, "refresh-1") };
    await db.client.googleConnection.upsert({ where: { userId }, create: { userId, ...data }, update: { ...data, status: "CONNECTED", brokenAt: null } });
  };

  const build = (llm: LlmClient) => {
    connection = new GoogleConnection(db.client, keys, { clientId: "client.apps.googleusercontent.com", clientSecret: "secret-123456", fetch: google.fetch as unknown as typeof fetch, apiBase: API });
    const deps = { google: connection, appOrigin: "https://storm.test" };
    const desk = new TakeoverDesk(db.client, () => Promise.resolve(), {
      timeoutMs: 20_000,
      pollMs: 100,
      notify: (message) => Promise.resolve(void telegram.push(`${message.text} [${(message.buttons ?? []).flat().map((b) => ("url" in b ? `${b.text} ${b.url}` : b.text)).join(", ")}]`)),
    });
    const executors = new ExecutorRegistry([new ExtractStep(llm, new ModelRouter(async () => null)), new CalendarFindStep(deps), new CalendarCreateStep(deps)]);
    runner = new PipelineRunner(db.client, defaultCatalog(), executors, new RunControls(db.client), undefined, desk);
  };

  beforeEach(async () => {
    google = new FakeGoogle();
    telegram = [];
    await connect();
    build(new Reader({ start: "2026-11-12T10:00", company: "Acme", place: "https://meet.google.com/abc-defg-hij" }));
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.googleConnection.deleteMany();
    await db.client.scheduledStart.deleteMany();
    await db.client.userSetting.updateMany({ data: { paused: false } });
  });

  afterAll(async () => {
    await db.close();
  });

  const compiler = new PipelineCompiler(defaultCatalog());
  const proposalOf = (runId: string) => db.client.proposal.findFirstOrThrow({ where: { runId } });
  async function approve(proposal: Proposal) {
    const finalPayload = proposal.originalPayload as Record<string, unknown>;
    await db.client.proposal.update({
      where: { proposalId: proposal.proposalId },
      data: { status: "APPROVED", finalPayload: finalPayload as Prisma.InputJsonValue, payloadHash: payloadHash(finalPayload) },
    });
  }
  const until = async <T>(read: () => Promise<T | null | undefined>, what: string): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  it("M14-I1: an invite email becomes a proposed event at the right time in the right zone; Act creates it once", async () => {
    const runId = await runner.start(await createVersion(db.client, userId, EVENT(), compiler), { trigger: "manual" });
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");

    // The gate shows exactly what will be created; nothing is in the calendar yet.
    const proposal = await proposalOf(runId);
    expect(proposal.originalPayload).toEqual({
      title: "Interview: Acme",
      start: "2026-11-12T10:00",
      location: "https://meet.google.com/abc-defg-hij",
      durationMinutes: 60,
      timeZone: "Europe/Sofia",
      meet: false,
      sendInvites: true,
    });
    expect(google.inserts).toEqual([]);

    await approve(proposal);
    expect(await runner.advance(runId)).toBe("DONE");
    // 10:00 in Sofia on 12 November (EET, +02:00) is 08:00Z.
    expect(google.inserts).toHaveLength(1);
    expect(google.inserts[0].body).toMatchObject({
      summary: "Interview: Acme",
      location: "https://meet.google.com/abc-defg-hij",
      start: { dateTime: "2026-11-12T08:00:00.000Z", timeZone: "Europe/Sofia" },
      end: { dateTime: "2026-11-12T09:00:00.000Z", timeZone: "Europe/Sofia" },
    });
    expect(google.inserts[0].query.get("sendUpdates")).toBe("none");
    const step = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "event" } });
    expect(step.output).toMatchObject({ created: true, link: expect.stringContaining("calendar.google.com") as unknown, invited: [] });
    expect(await db.client.googleConnection.findUniqueOrThrow({ where: { userId } })).toMatchObject({ status: "CONNECTED", lastWorkedAt: expect.any(Date) as unknown });

    // The same invite again: the event is there, so it isn't created a second time.
    const again = await runner.start(await createVersion(db.client, userId, EVENT().replace("Interview event", "Interview event 2"), compiler), { trigger: "manual" });
    await runner.advance(again);
    await approve(await proposalOf(again));
    expect(await runner.advance(again)).toBe("DONE");
    expect(google.inserts).toHaveLength(1);
    expect((await db.client.step.findFirstOrThrow({ where: { runId: again, stepKey: "event" } })).output).toMatchObject({ created: false });
  });

  it("M14-S1: calendar.create runs only with an approved, hash-matching proposal", async () => {
    const runId = await runner.start(await createVersion(db.client, userId, EVENT(), compiler), { trigger: "manual" });
    await runner.advance(runId);
    // Not approved: advancing again creates nothing.
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    const proposal = await proposalOf(runId);
    await approve(proposal);
    // Changed after approval (another time, a guest): refused, nothing created.
    await db.client.proposal.update({
      where: { proposalId: proposal.proposalId },
      data: { finalPayload: { ...(proposal.originalPayload as object), start: "2026-11-13T03:00", attendees: ["eve@evil.test"] } },
    });
    expect(await runner.advance(runId)).toBe("FAILED");
    expect(google.inserts).toEqual([]);
    expect((await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "event" } })).error).toMatch(/payload changed after approval/);
  });

  it("guests are targets: a guest the user wrote gets Google's invitation; one the LLM read out of the email can't be a guest", async () => {
    const withGuest = (to: string) => EVENT(`      attendees: [${to}]\n`).replace("name: Interview event", `name: Interview with ${to}\npolicy: { allowedRecipients: [maria@acme.test] }`);
    const runId = await runner.start(await createVersion(db.client, userId, withGuest("maria@acme.test"), compiler), { trigger: "manual" });
    await runner.advance(runId);
    await approve(await proposalOf(runId));
    expect(await runner.advance(runId)).toBe("DONE");
    expect(google.inserts[0].body.attendees).toEqual([{ email: "maria@acme.test" }]);
    expect(google.inserts[0].query.get("sendUpdates")).toBe("all");
    expect(compiler.compileText(withGuest('"{{invite.values.place}}"'))).toMatchObject({
      ok: false,
      errors: [{ path: "steps[1].with.attendees[0]", message: expect.stringMatching(/LLM/) as unknown }],
    });
  });

  it("calendar.find lists the events in a window, and says when there are none", async () => {
    google.events.push({
      id: "standup",
      summary: "Standup",
      start: { dateTime: "2026-11-12T08:30:00Z" },
      end: { dateTime: "2026-11-12T08:45:00Z" },
      htmlLink: "https://calendar.google.com/event?eid=standup",
    });
    const find = new CalendarFindStep({ google: connection });
    const context = { runId: "00000000-0000-4000-8000-000000000001", userId, pipelineId: "p", stepId: "s", stepKey: "k", itemIndex: null, dryRun: false, recordUsage: () => undefined, attention: { checkpoint: () => Promise.resolve(), needMe: () => Promise.reject(new Error("no")) } };
    const input = (raw: Record<string, unknown>) => defaultCatalog().get("calendar.find")!.input.parse(raw);
    expect(await find.execute(input({ from: "2026-11-12T10:00", durationMinutes: 60 }), context)).toMatchObject({
      count: 1,
      none: false,
      events: [{ id: "standup", title: "Standup", start: "2026-11-12T08:30:00Z", allDay: false, link: "https://calendar.google.com/event?eid=standup" }],
    });
    expect(await find.execute(input({ from: "2026-11-12T11:00", durationMinutes: 60 }), context)).toMatchObject({ count: 0, none: true });
    // One token for both calls.
    expect(google.refreshes).toBe(1);
  });

  it("a refused connection: the run waits for the user with a Reconnect button, and goes on once they reconnect", async () => {
    google.tokenError = "invalid_grant";
    const runId = await runner.start(await createVersion(db.client, userId, EVENT(), compiler), { trigger: "manual" });
    await runner.advance(runId);
    await approve(await proposalOf(runId));
    const advancing = runner.advance(runId);

    const wait = await until(() => db.client.takeover.findFirst({ where: { runId, status: "OPEN" } }), "the reconnect wait");
    expect(wait).toMatchObject({ waitsFor: "google", stepKey: "event" });
    expect(wait.reason).toMatch(/^Google refused the token \(invalid_grant: Token has been expired or revoked\.\): it was revoked or has expired: reconnect it in Settings/);
    expect(await db.client.googleConnection.findUniqueOrThrow({ where: { userId } })).toMatchObject({ status: "NEEDS_RECONNECT", brokenAt: expect.any(Date) as unknown });
    expect(telegram).toEqual([expect.stringMatching(/^Storm needs you: Google refused the token .* at event\. \[Reconnect Google Calendar https:\/\/storm\.test\/settings#google\]$/)]);
    expect(google.inserts).toEqual([]);

    // What the api's callback does: a new token sealed, the connection CONNECTED, the waits continued.
    google.tokenError = null;
    await connect();
    await db.client.takeover.update({ where: { takeoverId: wait.takeoverId }, data: { status: "CONTINUED", resolvedAt: new Date() } });
    expect(await advancing).toBe("DONE");
    expect(google.inserts).toHaveLength(1);
  });

  describe("M14-I2: flow.later", () => {
    let queued: { job: LaterJob; at: Date }[];
    let later: LaterStarts;
    let triggers: Triggers;
    let reminder: Counting;

    const SCHEDULE = (after = "7d") => `
name: Schedule a follow-up
steps:
  - id: later
    type: flow.later
    with:
      pipeline: Follow-up reminder
      after: ${after}
      key: follow-up:app-1
      data: { job: { title: ".NET Lead", company: Acme } }
      cancelOn: { event: application.status, match: { applicationId: app-1 } }
`;
    const REMINDER = `
name: Follow-up reminder
trigger: { on: flow.later }
steps:
  - id: tell
    type: notify.telegram
    with: { text: "No answer from {{trigger.data.job.company}}" }
`;
    const CANCEL = `
name: Cancel the follow-up
steps:
  - id: cancel
    type: flow.cancel
    with: { key: follow-up:app-1 }
`;

    beforeEach(async () => {
      queued = [];
      later = new LaterStarts(db.client, { enqueueLater: (job, at) => Promise.resolve(void queued.push({ job, at })) });
      reminder = new Counting("notify.telegram", () => ({ sent: true }));
      runner = new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry([new FlowLaterStep(later), new FlowCancelStep(later), reminder]), new RunControls(db.client));
      triggers = new Triggers(db.client, runner, { enqueueRun: () => Promise.resolve() } as never, keys, later);
      const reminderVersion = await createVersion(db.client, userId, REMINDER, compiler);
      const { pipelineId } = await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: reminderVersion } });
      await db.client.pipeline.update({ where: { pipelineId }, data: { enabled: true, currentVersionId: reminderVersion } });
    });

    const schedule = async (source = SCHEDULE()) => {
      const runId = await runner.start(await createVersion(db.client, userId, source, compiler), { trigger: "manual" });
      expect(await runner.advance(runId)).toBe("DONE");
      return db.client.scheduledStart.findFirstOrThrow({ orderBy: { dateCreated: "desc" } });
    };
    /** The job woke at its time. */
    const fire = async (id: string) => {
      await db.client.scheduledStart.updateMany({ where: { scheduledStartId: id, status: "PENDING" }, data: { fireAt: new Date(Date.now() - 1000) } });
      const runId = await triggers.fireLater({ scheduledStartId: id });
      if (runId) await runner.advance(runId);
      return runId;
    };

    // M39-I2's flow.later part: scheduled by the id its version was saved with, its target renamed since
    it("starts the pipeline its version named, by id, after it was renamed", async () => {
      const target = await db.client.pipeline.findFirstOrThrow({ where: { userId, enabled: true } });
      const scheduler = await createVersion(db.client, userId, SCHEDULE(), compiler);
      const named = (await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: scheduler } })).definition as {
        steps: { with: { pipeline?: string } }[];
      };
      const name = named.steps.find((s) => s.with.pipeline)!.with.pipeline!;
      await db.client.$executeRaw`UPDATE "PipelineVersions" SET definition = definition || ${JSON.stringify({ refs: { pipelines: { [name]: target.pipelineId } } })}::jsonb WHERE "pipelineVersionId" = ${scheduler}::uuid`;
      await db.client.pipeline.update({ where: { pipelineId: target.pipelineId }, data: { name: `${name} renamed` } });
      const runId = await runner.start(scheduler, { trigger: "manual" });
      expect(await runner.advance(runId)).toBe("DONE");
      const row = await db.client.scheduledStart.findFirstOrThrow({ orderBy: { dateCreated: "desc" } });
      expect(row.pipelineId).toBe(target.pipelineId);
      expect(await fire(row.scheduledStartId)).toEqual(expect.any(String));
    });

    it("starts the pipeline once, at its time, with the data", async () => {
      const row = await schedule();
      expect(row).toMatchObject({ status: "PENDING", key: "follow-up:app-1" });
      expect(row.fireAt.getTime() - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);
      expect(queued).toEqual([{ job: { scheduledStartId: row.scheduledStartId }, at: row.fireAt }]);
      // Woken early (a retry, a clock): nothing yet.
      expect(await triggers.fireLater({ scheduledStartId: row.scheduledStartId })).toBeNull();

      const runId = await fire(row.scheduledStartId);
      expect(runId).toEqual(expect.any(String));
      expect(reminder.calls).toEqual([{ text: "No answer from Acme" }]);
      expect(await db.client.scheduledStart.findUniqueOrThrow({ where: { scheduledStartId: row.scheduledStartId } })).toMatchObject({ status: "STARTED", runId });
      // The job delivered twice: one run.
      expect(await fire(row.scheduledStartId)).toBeNull();
      expect(reminder.calls).toHaveLength(1);
    });

    it("not after flow.cancel, an event matching cancelOn, a newer one with the same key, or with the kill switch on", async () => {
      const cancelled = await schedule();
      const runId = await runner.start(await createVersion(db.client, userId, CANCEL, compiler), { trigger: "manual" });
      await runner.advance(runId);
      expect(await fire(cancelled.scheduledStartId)).toBeNull();

      const byEvent = await schedule();
      await triggers.fire({ userId, event: "application.status", data: { applicationId: "app-2", status: "RESPONDED" }, source: { depth: 0 } });
      expect(await db.client.scheduledStart.findUniqueOrThrow({ where: { scheduledStartId: byEvent.scheduledStartId } })).toMatchObject({ status: "PENDING" });
      await triggers.fire({ userId, event: "application.status", data: { applicationId: "app-1", status: "RESPONDED" }, source: { depth: 0 } });
      expect(await db.client.scheduledStart.findUniqueOrThrow({ where: { scheduledStartId: byEvent.scheduledStartId } })).toMatchObject({
        status: "CANCELLED",
        reason: "cancelled by application.status",
      });

      const replaced = await schedule();
      const newer = await schedule(SCHEDULE("3d"));
      expect(await db.client.scheduledStart.findUniqueOrThrow({ where: { scheduledStartId: replaced.scheduledStartId } })).toMatchObject({ status: "CANCELLED" });

      await db.client.userSetting.upsert({ where: { userId }, create: { userId, paused: true }, update: { paused: true } });
      expect(await fire(newer.scheduledStartId)).toBeNull();
      expect(await db.client.scheduledStart.findUniqueOrThrow({ where: { scheduledStartId: newer.scheduledStartId } })).toMatchObject({
        status: "SKIPPED",
        reason: "the kill switch was on",
      });
      expect(reminder.calls).toEqual([]);
    });

    it("refuses a pipeline that isn't started by flow.later, and a dry run schedules nothing", async () => {
      const wrong = SCHEDULE().replace("pipeline: Follow-up reminder", "pipeline: Cancel the follow-up");
      await createVersion(db.client, userId, CANCEL, compiler);
      const runId = await runner.start(await createVersion(db.client, userId, wrong, compiler), { trigger: "manual" });
      expect(await runner.advance(runId)).toBe("FAILED");
      expect((await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "later" } })).error).toBe(
        "\"Cancel the follow-up\" can't be started by flow.later: its trigger must be { on: flow.later }",
      );
      const dry = await runner.start(await createVersion(db.client, userId, SCHEDULE().replace("Schedule a follow-up", "Dry"), compiler), { trigger: "manual", dryRun: true });
      expect(await runner.advance(dry)).toBe("DONE");
      expect(await db.client.scheduledStart.count()).toBe(0);
    });
  });
});
