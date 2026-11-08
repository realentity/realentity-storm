import { type Prisma } from "@realentity/storm-db";
import { JobQueue } from "@realentity/storm-queue";
import {
  type CreateRuleRequest,
  type LearningView,
  type PipelineSuggestionView,
  type ReflectionView,
  type RuleView,
  type ServerEnv,
  type SuggestionStatusName,
  type UpdateRuleRequest,
} from "@realentity/storm-shared";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { EventsService } from "../events/events.service";

const RECENT_REFLECTIONS = 5;

type RuleRow = Prisma.RuleGetPayload<object>;

/**
 * The Rules page (docs/design.md §8): rules the user writes or approves, what reflection suggests, and asking for a
 * reflection. Suggested rules only become active through `update` (M6-U1); the worker reads active ones at every LLM
 * call.
 */
@Injectable()
export class LearningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueue,
    private readonly events: EventsService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  async view(userId: string): Promise<LearningView> {
    const db = this.prisma.client;
    const [rules, suggestions, reflections, examples, pipelines] = await Promise.all([
      db.rule.findMany({ where: { userId }, orderBy: [{ dateCreated: "desc" }] }),
      db.pipelineSuggestion.findMany({
        where: { userId, status: "OPEN" },
        include: { pipeline: { select: { name: true } } },
        orderBy: { dateCreated: "desc" },
      }),
      db.reflection.findMany({ where: { userId }, orderBy: { startedAt: "desc" }, take: RECENT_REFLECTIONS }),
      db.example.groupBy({ by: ["stepType"], where: { userId }, _count: { _all: true }, orderBy: { stepType: "asc" } }),
      db.pipeline.findMany({ where: { userId }, select: { pipelineId: true, name: true } }),
    ]);
    const names = new Map(pipelines.map((p) => [p.pipelineId, p.name]));
    return {
      rules: rules.map((rule) => ruleView(rule, names)),
      suggestions: suggestions.map((s): PipelineSuggestionView => ({
        suggestionId: s.suggestionId,
        pipelineId: s.pipelineId,
        pipelineName: s.pipeline.name,
        text: s.text,
        rationale: s.rationale,
        status: s.status,
        dateCreated: s.dateCreated.toISOString(),
      })),
      reflections: reflections.map((r): ReflectionView => ({
        reflectionId: r.reflectionId,
        status: r.status,
        since: r.since.toISOString(),
        until: r.until.toISOString(),
        decisions: r.decisions,
        costUsd:
          typeof (r.llmUsage as { costUsd?: unknown } | null)?.costUsd === "number" ? (r.llmUsage as { costUsd: number }).costUsd : null,
        error: r.error,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
      })),
      examples: examples.map((e) => ({ stepType: e.stepType, count: e._count._all })),
      embeddings: Boolean(this.env.OPENAI_API_KEY),
    };
  }

  /** A rule the user writes is active right away. */
  async createRule(userId: string, body: CreateRuleRequest): Promise<RuleView> {
    await this.assertPipeline(userId, body.pipelineId);
    const rule = await this.prisma.client.rule.create({
      data: { userId, text: body.text, stepType: body.stepType, pipelineId: body.pipelineId, status: "ACTIVE", source: "manual" },
    });
    await this.changed(userId);
    return ruleView(rule, await this.pipelineNames(userId));
  }

  async updateRule(userId: string, ruleId: string, body: UpdateRuleRequest): Promise<RuleView> {
    await this.findRule(userId, ruleId);
    if (body.pipelineId !== undefined) await this.assertPipeline(userId, body.pipelineId);
    const rule = await this.prisma.client.rule.update({ where: { ruleId }, data: body });
    await this.changed(userId);
    return ruleView(rule, await this.pipelineNames(userId));
  }

  async deleteRule(userId: string, ruleId: string): Promise<void> {
    await this.findRule(userId, ruleId);
    await this.prisma.client.rule.delete({ where: { ruleId } });
    await this.changed(userId);
  }

  async updateSuggestion(userId: string, suggestionId: string, status: SuggestionStatusName): Promise<void> {
    const updated = await this.prisma.client.pipelineSuggestion.updateMany({ where: { suggestionId, userId }, data: { status } });
    if (updated.count === 0) throw new NotFoundException();
    await this.changed(userId);
  }

  /** A reflection now, besides the nightly one; the worker skips it when there is nothing new to learn from. */
  async requestReflection(userId: string): Promise<void> {
    await this.queue.requestReflection(userId);
  }

  private async findRule(userId: string, ruleId: string): Promise<RuleRow> {
    const rule = await this.prisma.client.rule.findFirst({ where: { ruleId, userId } });
    if (!rule) throw new NotFoundException();
    return rule;
  }

  private async assertPipeline(userId: string, pipelineId: string | null): Promise<void> {
    if (pipelineId === null) return;
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } });
    if (!pipeline) throw new BadRequestException({ message: "No such pipeline", errors: [{ path: "pipelineId", message: "not found" }] });
  }

  private async pipelineNames(userId: string): Promise<Map<string, string>> {
    const pipelines = await this.prisma.client.pipeline.findMany({ where: { userId }, select: { pipelineId: true, name: true } });
    return new Map(pipelines.map((p) => [p.pipelineId, p.name]));
  }

  private changed(userId: string): Promise<void> {
    return this.events.publish(userId, { type: "learning" });
  }
}

function ruleView(rule: RuleRow, pipelineNames: Map<string, string>): RuleView {
  return {
    ruleId: rule.ruleId,
    stepType: rule.stepType,
    pipelineId: rule.pipelineId,
    pipelineName: rule.pipelineId ? (pipelineNames.get(rule.pipelineId) ?? null) : null,
    text: rule.text,
    rationale: rule.rationale,
    status: rule.status,
    source: rule.source,
    dateCreated: rule.dateCreated.toISOString(),
    dateUpdated: rule.dateUpdated.toISOString(),
  };
}
