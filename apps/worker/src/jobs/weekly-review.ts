import { llmCostSince, topicCostsSince, type PrismaClient } from "@realentity/storm-db";
import { defaultTimeZone, type TelegramMessage } from "@realentity/storm-shared";
import { Logger } from "@nestjs/common";
import { type RunControls } from "../runner/run-controls";
import { DigestStep } from "../steps/digest-step";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** The step types (and models) that cost the most this week. */
const TOP_COSTS = 3;

/**
 * The weekly review (M19-T4, docs/design.md §12): Sunday evening on the Storm bot. The 7-day digest (runs, failures, what
 * waits for the user, reflection's suggestions, broken recipes, the LLM cost) and what a week shows better than a day: the
 * budget so far, where the money went, recipes that have found nothing for a while.
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
        buttons: this.appOrigin ? [[{ text: "Open Storm", url: this.appOrigin }]] : undefined,
      });
    }
    if (users.length > 0) this.logger.log(`Weekly review sent to ${users.length} user(s)`);
    return users.length;
  }

  async compose(userId: string, now = new Date()): Promise<string> {
    const since = new Date(now.getTime() - WEEK_MS);
    const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: defaultTimeZone() });
    const lines = [await new DigestStep(this.prisma).compose(userId, 168, null, now, `Storm · weekly review, ${day(since)} – ${day(now)}`)];

    const [settings, month, costs, topics] = await Promise.all([
      this.prisma.userSetting.findUnique({ where: { userId } }),
      this.controls.monthlySpendUsd(userId, now),
      llmCostSince(this.prisma, userId, since),
      topicCostsSince(this.prisma, userId, since),
    ]);
    const budget = this.controls.budgetOf(settings);
    if (budget !== undefined) {
      lines.push(`Budget: $${month.toFixed(2)} of $${budget.toFixed(2)} this month (${Math.round((month / budget) * 100)}%)`);
    }
    if (costs.length > 0) {
      const top = costs.slice(0, TOP_COSTS).map((row) => `${row.source} (${row.model}) $${row.costUsd.toFixed(2)}`);
      lines.push(`Most of it: ${top.join("; ")}`);
    }
    // M44-T5: what keeping each topic up to date cost this week.
    if (topics.length > 0) {
      lines.push(`Topics: ${topics.slice(0, TOP_COSTS).map((t) => `${t.name} $${t.costUsd.toFixed(2)}`).join(", ")}`);
    }

    const quiet = await this.quietRecipes(userId);
    if (quiet.length > 0) lines.push(`Quiet recipes: ${quiet.join(", ")} (Recipes page)`);
    return lines.join("\n");
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
