import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type TelegramMessage } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { MorningBrief, type BriefEvent } from "../src/jobs/morning-brief";
import { createVersion } from "./support/test-steps";

const SIMPLE = (name: string) => `
name: ${name}
steps:
  - id: tell
    type: notify.telegram
    with: { text: hi }
`;

const HOUR = 3_600_000;

// M25-I1
describe("morning brief", () => {
  let db: PrismaConnection;
  let userId: string;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  // Other suites may leave a setting row (the brief off).
  beforeEach(async () => {
    await db.client.userSetting.deleteMany();
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
    await db.client.userSetting.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  // Tuesday 3 November 2026, 07:30 in Sofia (UTC+2).
  const now = new Date("2026-11-03T05:30:00Z");

  it("today's calendar, what waits, what failed in the last day, unpaid bills due soon", async () => {
    const replies = await createVersion(db.client, userId, SIMPLE("Recruiter replies"));
    const jobs = await createVersion(db.client, userId, SIMPLE("Job search"));
    const run = (pipelineVersionId: string, status: "FAILED" | "WAITING_FOR_USER" | "DONE", hoursAgo: number, summary?: string, dryRun = false) =>
      db.client.run.create({ data: { userId, pipelineVersionId, trigger: "schedule", status, summary, dryRun, startedAt: new Date(now.getTime() - hoursAgo * HOUR) } });

    const waiting = await run(replies, "WAITING_FOR_USER", 2);
    for (const itemIndex of [0, 1]) {
      const gate = await db.client.step.create({ data: { runId: waiting.runId, stepKey: "sendGate", itemIndex, type: "gate.act", status: "WAITING" } });
      await db.client.proposal.create({
        data: { userId, runId: waiting.runId, stepId: gate.stepId, stepKey: "send", itemIndex, status: "PENDING_REVIEW", target: "ana@acme.test", originalPayload: {} },
      });
    }
    const live = await run(jobs, "WAITING_FOR_USER", 1);
    await db.client.takeover.create({ data: { runId: live.runId, status: "OPEN", reason: "A CAPTCHA" } });
    await run(jobs, "FAILED", 6, "dev.bg/search no longer matches the page");
    await run(jobs, "FAILED", 30, "too old to tell");
    await run(jobs, "FAILED", 3, "a dry run", true);

    // M33: Bill entities of a Bills App; paid ones are left out.
    const { appId } = await db.client.app.create({ data: { userId, name: "Bills" } });
    const bill = (issuer: string, amount: number, dueDate: string, paid = false) =>
      db.client.dataEntity.create({
        data: {
          appId,
          type: "Bill",
          key: `${issuer}|${dueDate}`,
          value: { billKey: `${issuer}|${dueDate}`, issuer, issuerKey: issuer, amount, currency: "BGN", dueDate, month: `${dueDate.slice(0, 7)}-01` },
          stage: paid ? "paid" : "due",
        },
      });
    await bill("telco", 30, "2026-11-01");
    await bill("evn", 84.2, "2026-11-03");
    await bill("water", 21.5, "2026-11-06");
    await bill("rent", 900, "2026-11-07");
    await bill("gas", 40, "2026-11-02", true);

    const events: BriefEvent[] = [
      { title: "Interview with Acme", start: new Date("2026-11-03T08:00:00Z"), allDay: false, location: "Google Meet" },
      { title: "Mum's birthday", start: new Date("2026-11-03T00:00:00"), allDay: true, location: null },
    ];
    const asked: [Date, Date][] = [];
    const brief = new MorningBrief(db.client, () => Promise.resolve(), (_user, from, to) => (asked.push([from, to]), Promise.resolve(events)));

    expect((await brief.compose(userId, now)).split("\n")).toEqual([
      "Storm · Tuesday 3 November",
      "Today:",
      "• 10:00 Interview with Acme (Google Meet)",
      "• all day Mum's birthday",
      "Waiting for you: 2 to approve (Recruiter replies: 2); 1 run(s) need you in the live view",
      "Failed in the last day:",
      "• Job search: dev.bg/search no longer matches the page",
      "Bills:",
      "• telco: 30.00 BGN, overdue since 2026-11-01",
      "• evn: 84.20 BGN, due today",
      "• water: 21.50 BGN, due 2026-11-06",
    ]);
    // Today in Sofia: from its midnight (22:00 UTC the day before) to the next.
    expect(asked).toEqual([[new Date("2026-11-02T22:00:00Z"), new Date("2026-11-03T22:00:00Z")]]);
  });

  it("an empty day in one line; a calendar it can't read is said; off in Settings, nothing is sent", async () => {
    const sent: TelegramMessage[] = [];
    const quiet = new MorningBrief(db.client, (m) => (sent.push(m), Promise.resolve()), () => Promise.resolve(null), "https://storm.test");
    await expect(quiet.sendAll(now)).resolves.toBe(1);
    expect(sent[0]?.text).toBe("Storm · Tuesday 3 November\nNothing on the calendar, nothing waiting, nothing failed, no bills due.");
    expect(sent[0]?.buttons).toEqual([[{ text: "Open Storm", url: "https://storm.test" }]]);

    const broken = new MorningBrief(db.client, () => Promise.resolve(), () => Promise.reject(new Error("Google Calendar needs reconnecting")));
    expect((await broken.compose(userId, now)).split("\n")[1]).toBe("Calendar: can't be read (Google Calendar needs reconnecting)");

    await db.client.userSetting.create({ data: { userId, morningBrief: false } });
    await expect(quiet.sendAll(now)).resolves.toBe(0);
    expect(sent).toHaveLength(1);
  });
});
