import { type Prisma, type Takeover } from "@ai-me/db";
import { JobQueue } from "@ai-me/queue";
import {
  type CompiledDefinition,
  type CostsView,
  type RunDetailView,
  type RetryView,
  type RunFilter,
  type RunSummaryView,
  type ServerEnv,
  type StepUsageView,
  type TakeoverView,
} from "@ai-me/shared";
import { exampleTriggerData, StepCatalog } from "@ai-me/steps";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";
import { ControlsService } from "../controls/controls.service";
import { PrismaService } from "../database/prisma.service";
import { EventsService } from "../events/events.service";
import { questionView } from "../facts/facts.service";
import { PROPOSAL_INCLUDE, proposalView } from "../proposals/proposal-view";
import { runCosts } from "./run-costs";

/** The Costs page lists at most this many runs, newest first. */
const COSTS_LIMIT = 2000;

const RUN_INCLUDE = {
  pipelineVersion: { select: { pipelineId: true, version: true, pipeline: { select: { name: true } } } },
} satisfies Prisma.RunInclude;
type RunWithPipeline = Prisma.RunGetPayload<{ include: typeof RUN_INCLUDE }>;

/** Runs: started here by hand (or as a dry run), by schedules in the worker; executed by the worker. */
@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: StepCatalog,
    private readonly controls: ControlsService,
    private readonly queue: JobQueue,
    private readonly events: EventsService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  /** A run of the pipeline's current version. A dry run proposes but never executes a side effect. */
  async start(userId: string, pipelineId: string, dryRun: boolean, trigger: "manual" | "telegram" = "manual"): Promise<RunDetailView> {
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } });
    if (!pipeline?.currentVersionId) throw new NotFoundException();
    return this.startVersion(userId, pipeline.currentVersionId, dryRun, trigger);
  }

  /**
   * A run of one version (the current one, or a draft's dry run). `triggerData` is {{trigger.*}} of a run started
   * here for a trigger event (M27: a row's button on a pipeline's page).
   */
  async startVersion(
    userId: string,
    pipelineVersionId: string,
    dryRun: boolean,
    trigger: "manual" | "telegram" | "view" = "manual",
    triggerData?: Record<string, unknown>,
    /** M37-T3: a dry run stops after this step. */
    stopAfter?: string,
  ): Promise<RunDetailView> {
    await this.controls.assertNotPaused(userId);
    const version = await this.prisma.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId } });
    if (!version.savedAt && !dryRun) throw new ConflictException("A draft only gets dry runs; save it first");
    const definition = version.definition as unknown as CompiledDefinition;

    const run = await this.prisma.client.run.create({
      data: {
        userId,
        pipelineVersionId: version.pipelineVersionId,
        trigger: dryRun ? "dry-run" : trigger,
        dryRun,
        ...(dryRun && stopAfter ? { stopAfter } : {}),
        // A pipeline started by an event or a webhook gets an example of one in a dry run, so {{trigger.*}} has values.
        ...(dryRun && exampleTriggerData(definition.trigger)
          ? { triggerData: exampleTriggerData(definition.trigger) as Prisma.InputJsonValue }
          : {}),
        ...(triggerData && !dryRun ? { triggerData: triggerData as Prisma.InputJsonValue } : {}),
        headed: this.catalog.needsHeaded(definition.steps),
        status: "QUEUED",
      },
    });
    await this.events.publish(userId, { type: "run", runId: run.runId, pipelineId: version.pipelineId, status: "QUEUED" });
    await this.queue.enqueueRun(run);
    return this.get(userId, run.runId);
  }

  async list(userId: string, filter: RunFilter): Promise<RunSummaryView[]> {
    // `to` (a day, inclusive) and `before` (paging) both bound startedAt from above: the tighter one wins.
    const upper = [filter.to ? dayAfter(filter.to) : null, filter.before ? new Date(filter.before) : null]
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const startedAt: Prisma.DateTimeFilter = {
      ...(filter.from ? { gte: new Date(`${filter.from}T00:00:00.000Z`) } : {}),
      ...(upper ? { lt: upper } : {}),
    };
    const runs = await this.prisma.client.run.findMany({
      where: {
        userId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.pipelineId
          ? { pipelineVersion: { pipelineId: filter.pipelineId, ...(filter.version ? { version: filter.version } : {}) } }
          : {}),
        ...(Object.keys(startedAt).length > 0 ? { startedAt } : {}),
        ...(filter.target ? { proposals: { some: { target: { contains: filter.target, mode: "insensitive" } } } } : {}),
      },
      include: RUN_INCLUDE,
      orderBy: [{ startedAt: "desc" }, { runId: "desc" }],
      take: filter.limit,
    });
    const costs = await runCosts(
      this.prisma,
      runs.map((r) => r.runId),
    );
    return runs.map((run) => runSummary(run, costs.get(run.runId) ?? 0));
  }

  /** M28: every run of the last `days` (up to COSTS_LIMIT, newest first), with the steps that called the LLM. */
  async costs(userId: string, days: number, now = new Date()): Promise<CostsView> {
    const since = new Date(now.getTime() - days * 86_400_000);
    const runs = await this.prisma.client.run.findMany({
      where: { userId, startedAt: { gte: since } },
      include: {
        ...RUN_INCLUDE,
        steps: {
          select: { stepKey: true, itemIndex: true, type: true, llmUsage: true },
          orderBy: [{ startedAt: { sort: "asc", nulls: "last" } }, { itemIndex: "asc" }],
        },
      },
      orderBy: [{ startedAt: "desc" }, { runId: "desc" }],
      take: COSTS_LIMIT + 1,
    });
    return {
      days,
      since: since.toISOString(),
      limit: COSTS_LIMIT,
      truncated: runs.length > COSTS_LIMIT,
      runs: runs.slice(0, COSTS_LIMIT).map((run) => {
        const steps = run.steps.flatMap((s) => {
          const usage = stepUsage(s.llmUsage);
          return usage ? [{ stepKey: s.stepKey, itemIndex: s.itemIndex, type: s.type, ...usage }] : [];
        });
        return {
          runId: run.runId,
          pipelineId: run.pipelineVersion.pipelineId,
          pipelineName: run.pipelineVersion.pipeline.name,
          version: run.pipelineVersion.version,
          trigger: run.trigger,
          dryRun: run.dryRun,
          status: run.status,
          startedAt: run.startedAt.toISOString(),
          costUsd: Math.round(steps.reduce((sum, s) => sum + s.costUsd, 0) * 1_000_000) / 1_000_000,
          steps,
        };
      }),
    };
  }

  /**
   * M17-T1: a failed run goes on from its failed steps: they are cleared and the run queued again, the steps before
   * keep their outputs (an LLM step isn't paid for twice), what already ran is never repeated. Not when a side effect
   * failed: it may have gone out (an email, a form), so that is a new run, after I checked.
   */
  async retry(userId: string, runId: string): Promise<RunDetailView> {
    await this.controls.assertNotPaused(userId);
    const run = await this.prisma.client.run.findFirst({ where: { runId, userId }, include: { steps: true } });
    if (!run) throw new NotFoundException();
    const check = this.retryCheck(run.status, run.steps);
    if (!check?.possible) throw new ConflictException(check?.reason ?? "Only a failed run can be retried");
    await this.prisma.client.$transaction([
      this.prisma.client.step.deleteMany({ where: { runId, status: "FAILED" } }),
      this.prisma.client.run.update({ where: { runId }, data: { status: "QUEUED", finishedAt: null, summary: null, resumeAt: null } }),
    ]);
    const version = await this.prisma.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: run.pipelineVersionId } });
    await this.events.publish(userId, { type: "run", runId, pipelineId: version.pipelineId, status: "QUEUED" });
    await this.queue.enqueueRun(run);
    return this.get(userId, runId);
  }

  /** Null for a run that didn't fail. */
  private retryCheck(status: string, steps: { status: string; type: string; stepKey: string }[]): RetryView | null {
    if (status !== "FAILED") return null;
    const failed = steps.filter((s) => s.status === "FAILED");
    // A side effect failed, or left running: it may have gone out.
    const sideEffect = steps.find((s) => (s.status === "FAILED" || s.status === "RUNNING") && this.catalog.get(s.type)?.sideEffect);
    if (sideEffect) {
      return {
        possible: false,
        reason: `${sideEffect.stepKey} (${sideEffect.type}) failed and may have gone out: check, then start a new run`,
      };
    }
    if (failed.length === 0) return { possible: false, reason: "No failed step to go on from: start a new run" };
    return { possible: true, reason: null };
  }

  async get(userId: string, runId: string): Promise<RunDetailView> {
    const run = await this.prisma.client.run.findFirst({
      where: { runId, userId },
      include: {
        ...RUN_INCLUDE,
        steps: { orderBy: [{ startedAt: { sort: "asc", nulls: "last" } }, { itemIndex: "asc" }] },
        proposals: { include: PROPOSAL_INCLUDE, orderBy: [{ dateCreated: "asc" }, { itemIndex: "asc" }] },
        takeovers: { where: { status: { in: ["OPEN", "TAKEN_OVER"] } }, orderBy: { requestedAt: "desc" }, take: 1 },
        questions: { where: { status: "OPEN" }, orderBy: { dateCreated: "desc" }, take: 1 },
        artifacts: { orderBy: { dateCreated: "asc" } },
      },
    });
    if (!run) throw new NotFoundException();
    const usage = run.steps.map((s) => stepUsage(s.llmUsage));
    const takeover = run.takeovers[0];
    const costUsd = Math.round(usage.reduce((sum, u) => sum + (u?.costUsd ?? 0), 0) * 1_000_000) / 1_000_000;
    return {
      ...runSummary(run, costUsd),
      costUsd,
      retry: this.retryCheck(run.status, run.steps),
      headed: run.headed,
      triggerData: run.triggerData ?? null,
      stopAfter: run.stopAfter,
      question: run.questions[0] ? questionView(run.questions[0]) : null,
      takeover: takeover ? takeoverView(takeover, this.env.TAKEOVER_TIMEOUT_MINUTES) : null,
      artifacts: run.artifacts.map((a) => ({
        artifactId: a.artifactId,
        kind: a.kind,
        stepKey: a.stepKey,
        itemIndex: a.itemIndex,
        mime: a.mime,
        size: a.size,
        dateCreated: a.dateCreated.toISOString(),
      })),
      steps: run.steps.map((s, index) => ({
        stepId: s.stepId,
        stepKey: s.stepKey,
        itemIndex: s.itemIndex,
        type: s.type,
        status: s.status,
        input: s.input,
        output: s.output,
        error: s.error,
        startedAt: s.startedAt?.toISOString() ?? null,
        finishedAt: s.finishedAt?.toISOString() ?? null,
        llmUsage: usage[index] ?? null,
      })),
      proposals: run.proposals.map(proposalView),
    };
  }
}

export function takeoverView(takeover: Takeover, timeoutMinutes: number): TakeoverView {
  return {
    takeoverId: takeover.takeoverId,
    status: takeover.status,
    reason: takeover.reason,
    stepKey: takeover.stepKey,
    itemIndex: takeover.itemIndex,
    url: takeover.url,
    waitsFor: takeover.waitsFor,
    requestedAt: takeover.requestedAt.toISOString(),
    expiresAt: new Date(takeover.requestedAt.getTime() + timeoutMinutes * 60_000).toISOString(),
  };
}

function dayAfter(day: string): Date {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000);
}

/** The part of Step.llmUsage the run page shows (the stored shape is @ai-me/llm's LlmUsage). */
function stepUsage(value: Prisma.JsonValue): StepUsageView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const count = (field: string) => (typeof usage[field] === "number" ? usage[field] : 0);
  return {
    models: Array.isArray(usage.models) ? usage.models.filter((m): m is string => typeof m === "string") : [],
    calls: count("calls"),
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
    cacheReadTokens: count("cacheReadTokens"),
    cacheWriteTokens: count("cacheWriteTokens"),
    costUsd: count("costUsd"),
  };
}

function runSummary(run: RunWithPipeline, costUsd: number): RunSummaryView {
  return {
    costUsd,
    runId: run.runId,
    pipelineId: run.pipelineVersion.pipelineId,
    pipelineName: run.pipelineVersion.pipeline.name,
    version: run.pipelineVersion.version,
    trigger: run.trigger,
    dryRun: run.dryRun,
    status: run.status,
    summary: run.summary,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    resumeAt: run.resumeAt?.toISOString() ?? null,
  };
}
