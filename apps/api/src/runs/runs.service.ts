import { type Prisma, type Takeover } from "@ai-me/db";
import { JobQueue } from "@ai-me/queue";
import {
  type CompiledDefinition,
  type RunDetailView,
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
import { PROPOSAL_INCLUDE, proposalView } from "../proposals/proposal-view";

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

  /** A run of one version (the current one, or a draft's dry run). */
  async startVersion(userId: string, pipelineVersionId: string, dryRun: boolean, trigger: "manual" | "telegram" = "manual"): Promise<RunDetailView> {
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
        // A pipeline started by an event or a webhook gets an example of one in a dry run, so {{trigger.*}} has values.
        ...(dryRun && exampleTriggerData(definition.trigger) ? { triggerData: exampleTriggerData(definition.trigger) as Prisma.InputJsonValue } : {}),
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
    return runs.map(runSummary);
  }

  async get(userId: string, runId: string): Promise<RunDetailView> {
    const run = await this.prisma.client.run.findFirst({
      where: { runId, userId },
      include: {
        ...RUN_INCLUDE,
        steps: { orderBy: [{ startedAt: { sort: "asc", nulls: "last" } }, { itemIndex: "asc" }] },
        proposals: { include: PROPOSAL_INCLUDE, orderBy: [{ dateCreated: "asc" }, { itemIndex: "asc" }] },
        takeovers: { where: { status: { in: ["OPEN", "TAKEN_OVER"] } }, orderBy: { requestedAt: "desc" }, take: 1 },
        artifacts: { orderBy: { dateCreated: "asc" } },
      },
    });
    if (!run) throw new NotFoundException();
    const usage = run.steps.map((s) => stepUsage(s.llmUsage));
    const takeover = run.takeovers[0];
    return {
      ...runSummary(run),
      costUsd: Math.round(usage.reduce((sum, u) => sum + (u?.costUsd ?? 0), 0) * 1_000_000) / 1_000_000,
      headed: run.headed,
      triggerData: run.triggerData ?? null,
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
    costUsd: count("costUsd"),
  };
}

function runSummary(run: RunWithPipeline): RunSummaryView {
  return {
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
