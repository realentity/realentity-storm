import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type TelegramMessage } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { WeeklyReview } from "../src/jobs/weekly-review";
import { RunControls } from "../src/runner/run-controls";
import { createVersion } from "./support/test-steps";

const SIMPLE = (name: string) => `
name: ${name}
steps:
  - id: tell
    type: notify.telegram
    with: { text: hi }
`;

const DAY_MS = 86_400_000;

// M19-I3
describe("weekly review", () => {
  let db: PrismaConnection;
  let userId: string;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  // Other suites may leave a setting row (a budget, the review off).
  beforeEach(async () => {
    await db.client.userSetting.deleteMany();
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.application.deleteMany();
    await db.client.jobPosting.deleteMany();
    await db.client.siteRecipe.deleteMany();
    await db.client.userSetting.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  it("tells the week's runs, failures, cost against the budget, where it went, outcomes and quiet recipes", async () => {
    // Sunday 1 November 2026, 19:00 in Sofia; the month began on the 1st, so this month's spend is today's only.
    const now = new Date("2026-11-01T17:00:00Z");
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const jobs = await createVersion(db.client, userId, SIMPLE("Job search"));
    const run = async (status: "DONE" | "FAILED", daysAgo: number, costs: [string, string, number][] = [], summary?: string) => {
      const created = await db.client.run.create({
        data: { userId, pipelineVersionId: jobs, trigger: "schedule", status, summary, startedAt: ago(daysAgo) },
      });
      for (const [index, [type, model, costUsd]] of costs.entries()) {
        await db.client.step.create({
          data: {
            runId: created.runId,
            stepKey: `s${index}`,
            type,
            status: "DONE",
            startedAt: ago(daysAgo),
            llmUsage: { models: model.split(" + "), calls: 2, costUsd },
          },
        });
      }
    };

    await run("DONE", 0.1, [["llm.score", "claude-haiku-5-5", 0.5]]);
    await run("DONE", 3, [
      ["llm.score", "claude-haiku-5-5", 0.2],
      ["browser.agent", "claude-sonnet-5-5", 1.5],
    ]);
    await run("DONE", 5, [["email.draftReply", "claude-haiku-5-5 + claude-sonnet-5-5", 0.75]]);
    await run("FAILED", 2, [], "jobs.bg/search no longer matches the page");
    await run("DONE", 9, [["browser.agent", "claude-sonnet-5-5", 4]]); // last week
    await db.client.userSetting.create({ data: { userId, monthlyBudgetUsd: 20 } });

    const posting = (n: number) =>
      db.client.jobPosting.create({ data: { userId, source: "jobs.bg", url: `https://jobs.bg/${n}`, title: `Job ${n}` } });
    for (const [n, dates] of [
      [1, { status: "SUBMITTED", submittedAt: ago(2) }],
      [2, { status: "INTERVIEW", submittedAt: ago(20), respondedAt: ago(4), interviewAt: ago(4) }],
      [3, { status: "REJECTED", submittedAt: ago(30), rejectedAt: ago(1) }],
      [4, { status: "SUBMITTED", submittedAt: ago(12) }],
    ] as const) {
      await db.client.application.create({ data: { userId, jobPostingId: (await posting(n)).jobPostingId, ...dates } });
    }

    const recipe = (name: string, version: number, more: object) =>
      db.client.siteRecipe.create({ data: { userId, site: "jobs.bg", name, version, steps: {}, ...more } });
    await recipe("jobs.bg/search", 1, { quietToldAt: ago(1), lastItemsAt: ago(10) });
    await recipe("dev.bg/search", 1, { quietToldAt: ago(20), lastItemsAt: ago(30) });
    await recipe("dev.bg/search", 2, { lastItemsAt: ago(1) }); // the new version finds items

    const review = new WeeklyReview(db.client, new RunControls(db.client), () => Promise.resolve());
    const text = await review.compose(userId, now);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Storm · weekly review, 25 Oct – 1 Nov");
    expect(lines).toContain("Runs: 4 (3 done, 1 failed)");
    expect(lines).toContain("• Job search: jobs.bg/search no longer matches the page");
    expect(lines).toContain("LLM: $2.9500 (this month $0.50)");
    expect(lines).toContain("Budget: $0.50 of $20.00 this month (3%)");
    expect(lines).toContain(
      "Most of it: browser.agent (claude-sonnet-5-5) $1.50; email.draftReply (claude-haiku-5-5 + claude-sonnet-5-5) $0.75; llm.score (claude-haiku-5-5) $0.70",
    );
    expect(lines).toContain("Applications: 1 sent, 1 answered, 1 interview(s), 1 turned down");
    expect(lines).toContain("Quiet recipes: jobs.bg/search (nothing since 2026-10-22) (Recipes page)");
  });

  it("goes to whoever hasn't turned it off; a quiet week says so", async () => {
    const sent: TelegramMessage[] = [];
    const review = new WeeklyReview(db.client, new RunControls(db.client), (m) => (sent.push(m), Promise.resolve()), "https://storm.test");

    await expect(review.sendAll()).resolves.toBe(1);
    const lines = sent[0]?.text.split("\n") ?? [];
    expect(lines).toEqual(expect.arrayContaining(["Runs: none", "Waiting for me: nothing", "LLM: $0.0000 (this month $0.00)"]));
    expect(lines.filter((line) => /^(Budget|Most of it|Applications|Quiet recipes):/.test(line))).toEqual([]);
    expect(sent[0]?.buttons).toEqual([[{ text: "Open Storm", url: "https://storm.test" }]]);

    await db.client.userSetting.create({ data: { userId, weeklyReview: false } });
    await expect(review.sendAll()).resolves.toBe(0);
    expect(sent).toHaveLength(1);
  });
});
