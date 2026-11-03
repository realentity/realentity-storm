import { llmCostSince, type PrismaClient } from "@ai-me/db";
import { type TelegramMessage } from "@ai-me/shared";
import { Logger } from "@nestjs/common";
import { type RunControls } from "../runner/run-controls";
import { DigestStep } from "../steps/digest-step";
import { jobAppIds } from "../steps/job-entities";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** The step types (and models) that cost the most this week. */
const TOP_COSTS = 3;

/**
 * The weekly review (M19-T4, README §12): Sunday evening on the AI ME bot. The 7-day digest (runs, failures, what
 * waits for me, reflection's suggestions, broken recipes, the LLM cost) and what a week shows better than a day: the
 * budget so far, where the money went, application outcomes, recipes that have found nothing for a while.
 */
export class WeeklyReview {
  private readonly logger = new Logger(WeeklyReview.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly controls: RunControls,
    private readonly notify: (message: TelegramMessage) => Promise<void>,
    private readonly appOrigin?: string,
  ) {}

  /** To everyone who hasn't turned it off (the schedule's job). */
  async sendAll(now = new Date()): Promise<number> {
    const users = await this.prisma.user.findMany({
      where: { OR: [{ settings: null }, { settings: { weeklyReview: true } }] },
      select: { userId: true },
    });
    for (const { userId } of users) {
      await this.notify({
        text: await this.compose(userId, now),
        buttons: this.appOrigin ? [[{ text: "Open AI ME", url: this.appOrigin }]] : undefined,
      });
    }
    if (users.length > 0) this.logger.log(`Weekly review sent to ${users.length} user(s)`);
    return users.length;
  }

  async compose(userId: string, now = new Date()): Promise<string> {
    const since = new Date(now.getTime() - WEEK_MS);
    const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/Sofia" });
    const lines = [await new DigestStep(this.prisma).compose(userId, 168, null, now, `AI ME · weekly review, ${day(since)} – ${day(now)}`)];

    const [settings, month, costs] = await Promise.all([
      this.prisma.userSetting.findUnique({ where: { userId } }),
      this.controls.monthlySpendUsd(userId, now),
      llmCostSince(this.prisma, userId, since),
    ]);
    const budget = this.controls.budgetOf(settings);
    if (budget !== undefined) {
      lines.push(`Budget: $${month.toFixed(2)} of $${budget.toFixed(2)} this month (${Math.round((month / budget) * 100)}%)`);
    }
    if (costs.length > 0) {
      const top = costs.slice(0, TOP_COSTS).map((row) => `${row.source} (${row.model}) $${row.costUsd.toFixed(2)}`);
      lines.push(`Most of it: ${top.join("; ")}`);
    }

    const outcomes = await this.outcomes(userId, since);
    if (outcomes) lines.push(outcomes);
    const quiet = await this.quietRecipes(userId);
    if (quiet.length > 0) lines.push(`Quiet recipes: ${quiet.join(", ")} (Recipes page)`);
    return lines.join("\n");
  }

  /** Applications this week (M16): sent, and what employers did; nothing when none moved. */
  private async outcomes(userId: string, since: Date): Promise<string | null> {
    const jobApps = await jobAppIds(this.prisma, userId);
    if (jobApps.length > 0) return this.jobOutcomes(jobApps, since);
    const [sent, answered, interviews, rejected] = await Promise.all(
      (["submittedAt", "respondedAt", "interviewAt", "rejectedAt"] as const).map((field) =>
        this.prisma.application.count({ where: { userId, [field]: { gte: since } } }),
      ),
    );
    if (sent + answered + interviews + rejected === 0) return null;
    return `Applications: ${sent} sent, ${answered} answered, ${interviews} interview(s), ${rejected} turned down`;
  }

  /** M33: the same from the Jobs of my Apps, by the dates each reached its stages. */
  private async jobOutcomes(appIds: string[], since: Date): Promise<string | null> {
    const rows = await this.prisma.dataEntity.findMany({ where: { appId: { in: appIds }, type: "Job" }, select: { stageDates: true } });
    const after = since.toISOString();
    const count = (stage: string) => rows.filter((r) => ((r.stageDates as Record<string, string>)[stage] ?? "") >= after).length;
    const [sent, answered, interviews, rejected] = ["applied", "responded", "interview", "rejected"].map(count);
    if (sent + answered + interviews + rejected === 0) return null;
    return `Applications: ${sent} sent, ${answered} answered, ${interviews} interview(s), ${rejected} turned down`;
  }

  /** Recipes whose latest version has found nothing for a week (M18-T2). */
  private async quietRecipes(userId: string): Promise<string[]> {
    const rows = await this.prisma.siteRecipe.findMany({
      where: { userId },
      select: { name: true, quietToldAt: true, lastItemsAt: true, dateCreated: true },
      orderBy: { version: "desc" },
    });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!latest.has(row.name)) latest.set(row.name, row);
    return [...latest.values()]
      .filter((row) => row.quietToldAt)
      .map((row) => `${row.name} (nothing since ${(row.lastItemsAt ?? row.dateCreated).toISOString().slice(0, 10)})`);
  }
}
