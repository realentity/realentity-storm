import { type CompiledDefinition, type TopicUpkeepView } from "@realentity/storm-shared";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { ExamplesService } from "../examples/examples.service";

/**
 * Topic upkeep (M42, docs/design.md §8.1): whether a pipeline keeps the topics' memory up to date, and what is left
 * before it does. It is an ordinary pipeline of the user's, installed from the Topics page: edited, copied or deleted
 * like any other; deleted, the card offers it again.
 */
@Injectable()
export class TopicUpkeepService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly examples: ExamplesService,
  ) {}

  async status(userId: string): Promise<TopicUpkeepView> {
    const [pipelines, setup, topicsWithDirections] = await Promise.all([
      this.prisma.client.pipeline.findMany({ where: { userId, currentVersionId: { not: null } }, orderBy: { dateCreated: "desc" } }),
      this.examples.setup(userId),
      this.prisma.client.topic.count({ where: { userId, status: "ACTIVE", directions: { some: {} } } }),
    ]);
    const versions = await this.prisma.client.pipelineVersion.findMany({
      where: { pipelineVersionId: { in: pipelines.map((p) => p.currentVersionId!) } },
      select: { pipelineVersionId: true, definition: true },
    });
    const upkeeps = pipelines.filter((p) => {
      const definition = versions.find((v) => v.pipelineVersionId === p.currentVersionId)?.definition as unknown as
        CompiledDefinition | undefined;
      return definition?.steps.some((s) => s.type === "topic.extract") ?? false;
    });
    // An enabled one first: that is the one keeping memory up to date.
    const pipeline = upkeeps.find((p) => p.enabled) ?? upkeeps[0] ?? null;
    const base = {
      email: setup.email,
      emailProblem: setup.emailProblem,
      llm: setup.llm,
      topicsWithDirections,
    };
    if (!pipeline) return { pipeline: null, tried: false, lastRun: null, waiting: 0, ...base };

    const ofPipeline = { pipelineVersion: { pipelineId: pipeline.pipelineId } };
    const [lastRun, waiting] = await Promise.all([
      this.prisma.client.run.findFirst({ where: { userId, ...ofPipeline }, orderBy: { startedAt: "desc" } }),
      this.prisma.client.proposal.count({ where: { userId, status: "PENDING_REVIEW", run: ofPipeline } }),
    ]);
    return {
      pipeline: { pipelineId: pipeline.pipelineId, name: pipeline.name, enabled: pipeline.enabled },
      tried: lastRun !== null,
      lastRun: lastRun
        ? { runId: lastRun.runId, status: lastRun.status, dryRun: lastRun.dryRun, finishedAt: lastRun.finishedAt?.toISOString() ?? null }
        : null,
      waiting,
      ...base,
    };
  }
}
