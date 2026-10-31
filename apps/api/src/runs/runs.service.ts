import { type Prisma } from "@ai-me/db";
import { JobQueue } from "@ai-me/queue";
import { type CompiledDefinition, type RunDetailView, type RunSummaryView } from "@ai-me/shared";
import { StepCatalog } from "@ai-me/steps";
import { Injectable, NotFoundException } from "@nestjs/common";
import { ControlsService } from "../controls/controls.service";
import { PrismaService } from "../database/prisma.service";
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
  ) {}

  /** A run of the pipeline's current version. A dry run proposes but never executes a side effect. */
  async start(userId: string, pipelineId: string, dryRun: boolean): Promise<RunDetailView> {
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } });
    if (!pipeline?.currentVersionId) throw new NotFoundException();
    await this.controls.assertNotPaused(userId);
    const version = await this.prisma.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: pipeline.currentVersionId } });
    const definition = version.definition as unknown as CompiledDefinition;

    const run = await this.prisma.client.run.create({
      data: {
        userId,
        pipelineVersionId: version.pipelineVersionId,
        trigger: dryRun ? "dry-run" : "manual",
        dryRun,
        headed: this.catalog.needsHeaded(definition.steps),
        status: "QUEUED",
      },
    });
    await this.queue.enqueueRun(run);
    return this.get(userId, run.runId);
  }

  async list(userId: string, pipelineId: string | undefined, limit: number): Promise<RunSummaryView[]> {
    const runs = await this.prisma.client.run.findMany({
      where: { userId, ...(pipelineId ? { pipelineVersion: { pipelineId } } : {}) },
      include: RUN_INCLUDE,
      orderBy: { startedAt: "desc" },
      take: limit,
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
      },
    });
    if (!run) throw new NotFoundException();
    return {
      ...runSummary(run),
      steps: run.steps.map((s) => ({
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
      })),
      proposals: run.proposals.map(proposalView),
    };
  }
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
