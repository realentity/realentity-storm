import { Integrations, llmCostSince, llmSpendSince } from "@realentity/storm-db";
import { isOpenAiModel, ModelRouter, OpenAiApi, parseServerModel, serverModelId } from "@realentity/storm-llm";
import {
  BUILDER_CHAT_MAX_TOKENS,
  CLAUDE_MODELS,
  EFFORTS,
  LLM_TASKS,
  type EffortName,
  type KillSwitchView,
  type LlmTask,
  type ModelChoiceView,
  type SettingsRequest,
  type SettingsView,
  type SpendingView,
} from "@realentity/storm-shared";
import { StepCatalog } from "@realentity/storm-steps";
import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { EventsService } from "../events/events.service";

export const KILL_SWITCH_SUMMARY = "Stopped by the kill switch";

/** Kill switch and run-time settings (docs/design.md §2.2, §2.6, §5). The worker reads them at every step boundary. */
@Injectable()
export class ControlsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: StepCatalog,
    private readonly events: EventsService,
    private readonly integrations: Integrations,
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
    const [settings, modelSettings, prefs] = await Promise.all([
      this.prisma.client.userSetting.findUnique({ where: { userId } }),
      this.prisma.client.modelSetting.findMany({ where: { userId, taskKey: { in: [...LLM_TASKS] } } }),
      this.integrations.prefs(userId),
    ]);
    // What the worker uses (docs/design.md §5): a task's choice, else the default model, else the built-in one.
    const router = new ModelRouter(() => Promise.resolve(null));
    const models = Object.fromEntries(
      LLM_TASKS.map((task): [LlmTask, ModelChoiceView] => {
        const fallback = router.fallback(task, prefs);
        const own = modelSettings.find((s) => s.taskKey === task);
        if (!own) return [task, fallback];
        // Its server is off or gone: the task uses what it would without its choice, which waits.
        if (!prefs.usable(own.model)) return [task, { ...fallback, waiting: own.model }];
        const effort = (EFFORTS as readonly string[]).includes(own.effort ?? "") ? (own.effort as EffortName) : fallback.effort;
        return [task, { model: own.model, effort, source: "settings" }];
      }),
    ) as Record<LlmTask, ModelChoiceView>;
    return {
      models,
      defaultModel: settings?.defaultModel ?? null,
      servers: await this.servers(userId),
      embeddings: settings?.embeddingsIntegrationId && settings.embeddingsModel ? { integrationId: settings.embeddingsIntegrationId, model: settings.embeddingsModel } : null,
      builderChatMaxTokens: settings?.builderChatMaxTokens ?? BUILDER_CHAT_MAX_TOKENS,
      rateLimits: (settings?.rateLimits as Record<string, string> | null) ?? {},
      monthlyBudgetUsd: settings?.monthlyBudgetUsd != null ? Number(settings.monthlyBudgetUsd) : null,
      profile: settings?.profile ?? "",
      telegramApprovals: settings?.telegramApprovals ?? true,
      weeklyReview: settings?.weeklyReview ?? true,
      morningBrief: settings?.morningBrief ?? true,
    };
  }

  /**
   * M62: what can be chosen, by server: Claude's models, each model server's as it lists them (asked in parallel, a
   * few seconds at most); a server that doesn't answer says why, and the page still works.
   */
  private async servers(userId: string): Promise<SettingsView["servers"]> {
    const rows = await this.integrations.of(userId);
    return Promise.all(
      rows.map(async (row) => {
        const base = { integrationId: row.integrationId, kind: row.kind, name: row.name, enabled: row.enabled };
        if (row.kind === "CLAUDE") return { ...base, models: CLAUDE_MODELS.map((m) => ({ id: m, name: m })), error: null };
        if (!row.enabled || !row.baseUrl) return { ...base, models: [], error: null };
        try {
          const names = await new OpenAiApi({ baseUrl: row.baseUrl, apiKey: row.secret ?? undefined, timeoutMs: 5_000 }).models();
          return { ...base, models: names.map((name) => ({ id: serverModelId(row.integrationId, name), name })), error: null };
        } catch (error) {
          return { ...base, models: [], error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
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
    errors.push(...(await this.modelErrors(userId, body)));
    if (errors.length > 0) throw new BadRequestException({ message: "Validation failed", errors });

    const data = {
      ...(body.rateLimits !== undefined ? { rateLimits: body.rateLimits } : {}),
      ...(body.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: body.monthlyBudgetUsd } : {}),
      ...(body.profile !== undefined ? { profile: body.profile.trim() || null } : {}),
      ...(body.telegramApprovals !== undefined ? { telegramApprovals: body.telegramApprovals } : {}),
      ...(body.weeklyReview !== undefined ? { weeklyReview: body.weeklyReview } : {}),
      ...(body.morningBrief !== undefined ? { morningBrief: body.morningBrief } : {}),
      ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
      ...(body.embeddings !== undefined
        ? { embeddingsIntegrationId: body.embeddings?.integrationId ?? null, embeddingsModel: body.embeddings?.model ?? null }
        : {}),
      ...(body.builderChatMaxTokens !== undefined ? { builderChatMaxTokens: body.builderChatMaxTokens } : {}),
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

  /**
   * M62: a model is chosen only from a server that is set up (Claude's, or one of the model servers), and embeddings
   * only from a model server: a choice never points at nothing.
   */
  private async modelErrors(userId: string, body: SettingsRequest): Promise<{ path: string; message: string }[]> {
    const rows = await this.integrations.of(userId);
    const chosen = [
      ...(body.defaultModel ? [{ path: "defaultModel", model: body.defaultModel }] : []),
      ...Object.entries(body.models ?? {}).flatMap(([task, choice]) => (choice ? [{ path: `models.${task}`, model: choice.model }] : [])),
    ];
    const errors = chosen.flatMap(({ path, model }) => {
      if (!isOpenAiModel(model)) return rows.some((i) => i.kind === "CLAUDE") ? [] : [{ path, message: "Claude isn't set up: add it under Model servers" }];
      const { serverId } = parseServerModel(model);
      return rows.some((i) => i.integrationId === serverId && i.kind === "OPENAI_COMPATIBLE") ? [] : [{ path, message: "That model's server isn't set up" }];
    });
    if (body.embeddings && !rows.some((i) => i.integrationId === body.embeddings?.integrationId && i.kind === "OPENAI_COMPATIBLE")) {
      errors.push({ path: "embeddings", message: "Embeddings come from a model server: that one isn't set up" });
    }
    return errors;
  }
}
