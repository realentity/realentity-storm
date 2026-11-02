import { llmCostSince, llmSpendSince } from "@ai-me/db";
import { ModelRouter } from "@ai-me/llm";
import {
  EFFORTS,
  LLM_TASKS,
  type EffortName,
  type KillSwitchView,
  type LlmTask,
  type ModelChoiceView,
  type ServerEnv,
  type SettingsRequest,
  type SettingsView,
  type SpendingView,
} from "@ai-me/shared";
import { StepCatalog } from "@ai-me/steps";
import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { EventsService } from "../events/events.service";

export const KILL_SWITCH_SUMMARY = "Stopped by the kill switch";

/** Kill switch and run-time settings (README §2.2, §2.6, §5). The worker reads them at every step boundary. */
@Injectable()
export class ControlsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: StepCatalog,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
    private readonly events: EventsService,
  ) {}

  async isPaused(userId: string): Promise<boolean> {
    const settings = await this.prisma.client.userSetting.findUnique({ where: { userId }, select: { paused: true } });
    return settings?.paused ?? false;
  }

  /** Refuses actions that would start or continue work while the kill switch is on. */
  async assertNotPaused(userId: string): Promise<void> {
    if (await this.isPaused(userId)) throw new ConflictException("The kill switch is on");
  }

  async killSwitch(userId: string): Promise<KillSwitchView> {
    const settings = await this.prisma.client.userSetting.findUnique({ where: { userId } });
    return { engaged: settings?.paused ?? false, engagedAt: settings?.pausedAt?.toISOString() ?? null };
  }

  /**
   * Engaging pauses every pipeline (schedules fire but start nothing), stops queued and waiting runs, and expires
   * their open proposals, so no queued side effect can execute. Running runs stop at their next step boundary.
   * Releasing lets schedules start runs again; stopped runs stay stopped.
   */
  async setKillSwitch(userId: string, engaged: boolean): Promise<KillSwitchView> {
    const now = new Date();
    if (!engaged) {
      await this.prisma.client.userSetting.upsert({
        where: { userId },
        create: { userId, paused: false },
        update: { paused: false, pausedAt: null },
      });
      await this.events.publish(userId, { type: "killSwitch", engaged: false });
      return { engaged: false, engagedAt: null };
    }
    const stopped = await this.prisma.client.$transaction(async (tx) => {
      await tx.userSetting.upsert({
        where: { userId },
        create: { userId, paused: true, pausedAt: now },
        update: { paused: true, pausedAt: now },
      });
      const runs = await tx.run.updateManyAndReturn({
        where: { userId, status: { in: ["QUEUED", "WAITING_FOR_USER"] } },
        data: { status: "ABORTED", finishedAt: now, resumeAt: null, summary: KILL_SWITCH_SUMMARY },
        select: { runId: true },
      });
      await tx.proposal.updateMany({
        where: { runId: { in: runs.map((r) => r.runId) }, status: { in: ["PENDING_REVIEW", "APPROVED"] } },
        data: { status: "EXPIRED" },
      });
      return runs.length;
    });
    await this.events.publish(userId, { type: "killSwitch", engaged: true });
    return { engaged: true, engagedAt: now.toISOString(), stoppedRuns: stopped };
  }

  async settings(userId: string): Promise<SettingsView> {
    const [settings, modelSettings] = await Promise.all([
      this.prisma.client.userSetting.findUnique({ where: { userId } }),
      this.prisma.client.modelSetting.findMany({ where: { userId, taskKey: { in: [...LLM_TASKS] } } }),
    ]);
    const router = new ModelRouter(() => Promise.resolve(null), {
      LLM_MODEL_CLASSIFY: this.env.LLM_MODEL_CLASSIFY,
      LLM_MODEL_WRITING: this.env.LLM_MODEL_WRITING,
      LLM_MODEL_REFLECTION: this.env.LLM_MODEL_REFLECTION,
      LLM_MODEL_BUILDER: this.env.LLM_MODEL_BUILDER,
    });
    const models = Object.fromEntries(
      LLM_TASKS.map((task): [LlmTask, ModelChoiceView] => {
        const fallback = router.fallback(task);
        const own = modelSettings.find((s) => s.taskKey === task);
        if (!own) return [task, fallback];
        const effort = (EFFORTS as readonly string[]).includes(own.effort ?? "") ? (own.effort as EffortName) : fallback.effort;
        return [task, { model: own.model, effort, source: "settings" }];
      }),
    ) as Record<LlmTask, ModelChoiceView>;
    const own = settings?.monthlyBudgetUsd != null ? Number(settings.monthlyBudgetUsd) : null;
    const fromEnv = this.env.LLM_MONTHLY_BUDGET_USD ?? null;
    return {
      models,
      rateLimits: (settings?.rateLimits as Record<string, string> | null) ?? {},
      monthlyBudgetUsd: own ?? fromEnv,
      budgetSource: own !== null ? "settings" : fromEnv !== null ? "env" : null,
      profile: settings?.profile ?? "",
      telegramApprovals: settings?.telegramApprovals ?? true,
      weeklyReview: settings?.weeklyReview ?? true,
    };
  }

  /** This month's LLM cost against the budget, and the last 30 days by step type and model (M19-T3). */
  async spending(userId: string, now = new Date()): Promise<SpendingView> {
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const [settings, monthSpentUsd, rows] = await Promise.all([
      this.settings(userId),
      llmSpendSince(this.prisma.client, userId, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
      llmCostSince(this.prisma.client, userId, since),
    ]);
    const totalUsd = Math.round(rows.reduce((sum, row) => sum + row.costUsd, 0) * 1_000_000) / 1_000_000;
    return { monthSpentUsd, monthlyBudgetUsd: settings.monthlyBudgetUsd, since: since.toISOString(), totalUsd, rows };
  }

  async updateSettings(userId: string, body: SettingsRequest): Promise<SettingsView> {
    const errors = Object.keys(body.rateLimits ?? {}).flatMap((type) => {
      const step = this.catalog.get(type);
      if (!step) return [{ path: `rateLimits.${type}`, message: `unknown step type "${type}"` }];
      return step.sideEffect ? [] : [{ path: `rateLimits.${type}`, message: "only side-effect steps have rate limits" }];
    });
    if (errors.length > 0) throw new BadRequestException({ message: "Validation failed", errors });

    const data = {
      ...(body.rateLimits !== undefined ? { rateLimits: body.rateLimits } : {}),
      ...(body.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: body.monthlyBudgetUsd } : {}),
      ...(body.profile !== undefined ? { profile: body.profile.trim() || null } : {}),
      ...(body.telegramApprovals !== undefined ? { telegramApprovals: body.telegramApprovals } : {}),
      ...(body.weeklyReview !== undefined ? { weeklyReview: body.weeklyReview } : {}),
    };
    const models = Object.entries(body.models ?? {});
    await this.prisma.client.$transaction([
      this.prisma.client.userSetting.upsert({ where: { userId }, create: { userId, ...data }, update: data }),
      ...models.map(([taskKey, choice]) =>
        choice
          ? this.prisma.client.modelSetting.upsert({
              where: { userId_taskKey: { userId, taskKey } },
              create: { userId, taskKey, model: choice.model, effort: choice.effort },
              update: { model: choice.model, effort: choice.effort },
            })
          : this.prisma.client.modelSetting.deleteMany({ where: { userId, taskKey } }),
      ),
    ]);
    return this.settings(userId);
  }
}
