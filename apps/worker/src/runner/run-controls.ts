import { llmSpendSince, type PrismaClient, type UserSetting } from "@realentity/storm-db";
import { Logger } from "@nestjs/common";
import { LIMIT, type TelegramMessage } from "@realentity/storm-shared";

export interface RunControlsOptions {
  /** LLM_MONTHLY_BUDGET_USD; a UserSetting overrides it. */
  monthlyBudgetUsd?: number;
  /** The Storm bot: 80% of the budget spent, and the budget reached (M19-T2). Without it, nothing is told. */
  notify?: (message: TelegramMessage) => Promise<void>;
  appOrigin?: string;
}

/** Told once a month: most of the budget is spent. */
export const BUDGET_WARNING = 0.8;

/** What the runner needs to know about a run to apply the controls. */
export interface ControlledRun {
  userId: string;
  pipelineId: string;
  essential: boolean;
  /** The pipeline's own `limits` (step type → "N/day" | "N/hour"). */
  limits: Record<string, string>;
}

const WINDOW_MS = { hour: 3_600_000, day: 86_400_000 } as const;

/**
 * Run-time controls (README §2.2, §2.6, §5): the kill switch, the monthly LLM budget, and rate limits per step type.
 * Read from the database at every step boundary, so a change applies to runs already in progress.
 */
export class RunControls {
  private readonly logger = new Logger(RunControls.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: RunControlsOptions = {},
  ) {}

  /** Why the run must stop before this step (one that calls the LLM: the catalog's `llm`), or null. */
  async stopReason(run: ControlledRun, step: { llm?: boolean }): Promise<string | null> {
    const settings = await this.settings(run.userId);
    if (settings?.paused) return "Stopped by the kill switch";
    if (step.llm && (await this.budgetStops(run, settings))) {
      return "Monthly LLM budget reached: non-essential pipelines are paused until next month";
    }
    return null;
  }

  /** The budget stops this run's LLM calls: it is reached and the pipeline isn't essential. */
  async budgetStops(run: Pick<ControlledRun, "userId" | "essential">, known?: UserSetting | null): Promise<boolean> {
    return !run.essential && (await this.overBudget(run.userId, known));
  }

  /**
   * After LLM calls (M19-T2): at 80% of the budget, and when it is reached, a message on the Storm bot, once a month
   * each. Reached at once (one expensive step) is told as reached only. Never throws: spending goes on either way.
   */
  async tellBudget(userId: string, now = new Date()): Promise<void> {
    const { notify } = this.options;
    if (!notify) return;
    try {
      const settings = await this.settings(userId);
      const budget = this.budgetOf(settings);
      if (budget === undefined || budget <= 0) return;
      const spent = await this.monthlySpendUsd(userId, now);
      if (spent < budget * BUDGET_WARNING) return;
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const notThisMonth = (field: "budgetWarnedAt" | "budgetReachedAt") => ({ OR: [{ [field]: null }, { [field]: { lt: month } }] });
      if (!settings) await this.prisma.userSetting.upsert({ where: { userId }, create: { userId }, update: {} });
      const usd = (n: number) => `$${n.toFixed(2)}`;
      const button = this.options.appOrigin ? [[{ text: "Open Settings", url: `${this.options.appOrigin}/settings` }]] : undefined;

      if (spent >= budget) {
        // Claimed before sending, so two runs finishing at once tell it once.
        const claimed = await this.prisma.userSetting.updateMany({
          where: { userId, ...notThisMonth("budgetReachedAt") },
          data: { budgetReachedAt: now, budgetWarnedAt: now },
        });
        if (claimed.count === 0) return;
        const until = next.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
        await notify({
          text:
            `Storm: the monthly LLM budget (${usd(budget)}) is reached: ${usd(spent)} spent. Non-essential pipelines stop ` +
            `before their LLM steps until ${until}; essential ones go on. To continue now, raise the budget in Settings.`,
          buttons: button,
        });
        return;
      }
      const claimed = await this.prisma.userSetting.updateMany({ where: { userId, ...notThisMonth("budgetWarnedAt") }, data: { budgetWarnedAt: now } });
      if (claimed.count === 0) return;
      await notify({
        text:
          `Storm: ${usd(spent)} of the ${usd(budget)} monthly LLM budget is spent (${Math.floor((spent / budget) * 100)}%). ` +
          `When it is reached, non-essential pipelines stop before their LLM steps until next month. Settings shows where the money goes.`,
        buttons: button,
      });
    } catch (error) {
      this.logger.warn(`Budget message not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * For a side-effect step: when over a rate limit, the time the next execution is allowed; otherwise null.
   * The pipeline's own limit counts its runs; the global one (settings) counts every pipeline's.
   */
  async rateLimitedUntil(run: ControlledRun, stepType: string): Promise<Date | null> {
    const settings = await this.settings(run.userId);
    const global = (settings?.rateLimits as Record<string, string> | null)?.[stepType];
    const waits = await Promise.all([
      this.waitFor(run, stepType, run.limits[stepType], run.pipelineId),
      this.waitFor(run, stepType, global, null),
    ]);
    const until = waits.filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime());
    return until[0] ?? null;
  }

  /** LLM cost of the user's steps and reflections this calendar month (UTC). */
  async monthlySpendUsd(userId: string, now = new Date()): Promise<number> {
    return llmSpendSince(this.prisma, userId, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  }

  /** The monthly budget is reached (the nightly reflection is non-essential too). */
  async overBudget(userId: string, known?: UserSetting | null): Promise<boolean> {
    const settings = known === undefined ? await this.settings(userId) : known;
    const budget = this.budgetOf(settings);
    if (budget === undefined) return false;
    return (await this.monthlySpendUsd(userId)) >= budget;
  }

  /** The budget in effect: the setting, else LLM_MONTHLY_BUDGET_USD. */
  budgetOf(settings: UserSetting | null): number | undefined {
    return settings?.monthlyBudgetUsd != null ? Number(settings.monthlyBudgetUsd) : this.options.monthlyBudgetUsd;
  }

  private async waitFor(run: ControlledRun, stepType: string, limit: string | undefined, pipelineId: string | null): Promise<Date | null> {
    const match = limit ? LIMIT.exec(limit) : null;
    if (!match) return null;
    const max = Number(match[1]);
    const windowMs = WINDOW_MS[match[2] as keyof typeof WINDOW_MS];
    // Executions: side-effect steps that started (done, failed or still running), outside dry runs.
    const started = await this.prisma.step.findMany({
      where: {
        type: stepType,
        status: { in: ["RUNNING", "DONE", "FAILED"] },
        startedAt: { gte: new Date(Date.now() - windowMs) },
        run: { userId: run.userId, dryRun: false, ...(pipelineId ? { pipelineVersion: { pipelineId } } : {}) },
      },
      select: { startedAt: true },
      orderBy: { startedAt: "asc" },
    });
    if (started.length < max) return null;
    // Allowed again once enough of them have left the window.
    const oldest = started[started.length - max]?.startedAt;
    return oldest ? new Date(oldest.getTime() + windowMs) : null;
  }

  private settings(userId: string): Promise<UserSetting | null> {
    return this.prisma.userSetting.findUnique({ where: { userId } });
  }
}
