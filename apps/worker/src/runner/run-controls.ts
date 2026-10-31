import { type PrismaClient, type UserSetting } from "@ai-me/db";
import { LIMIT } from "@ai-me/shared";
import { llmSpendSince } from "./llm-spend";

export interface RunControlsOptions {
  /** LLM_MONTHLY_BUDGET_USD; a UserSetting overrides it. */
  monthlyBudgetUsd?: number;
}

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
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: RunControlsOptions = {},
  ) {}

  /** Why the run must stop before this step, or null. */
  async stopReason(run: ControlledRun, stepType: string): Promise<string | null> {
    const settings = await this.settings(run.userId);
    if (settings?.paused) return "Stopped by the kill switch";
    if (!run.essential && stepType.startsWith("llm.") && (await this.overBudget(run.userId, settings))) {
      return "Monthly LLM budget reached: non-essential pipelines are paused until next month";
    }
    return null;
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
    const budget = settings?.monthlyBudgetUsd != null ? Number(settings.monthlyBudgetUsd) : this.options.monthlyBudgetUsd;
    if (budget === undefined) return false;
    return (await this.monthlySpendUsd(userId)) >= budget;
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
