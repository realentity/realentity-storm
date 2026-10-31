import { Prisma, type PipelineVersion } from "@ai-me/db";
import { JobQueue } from "@ai-me/queue";
import {
  type CompiledDefinition,
  type CompiledPolicy,
  type CompilePipelineResponse,
  type CompileResult,
  type PipelineDetailView,
  type PipelineSummaryView,
  type PipelineVersionSummaryView,
  type PipelineVersionView,
  type UpdatePipelineRequest,
} from "@ai-me/shared";
import { diffDefinitions, PipelineCompiler } from "@ai-me/steps";
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

type Compiled = Extract<CompileResult, { ok: true }>;

/**
 * Pipelines and their versions (README §2.1–2.2). Every save compiles the source; a version stores the compiled
 * definition and policy, which is what runs execute. Versions are immutable; changes create a new one.
 */
@Injectable()
export class PipelinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly compiler: PipelineCompiler,
    private readonly queue: JobQueue,
  ) {}

  /** Compiles without saving, for the review screen; with a pipeline, also the diff against its current version. */
  async compile(userId: string, source: string, pipelineId?: string): Promise<CompilePipelineResponse> {
    const result = this.compiler.compileText(source);
    if (!result.ok || !pipelineId) return { result };
    const current = await this.currentVersion(userId, pipelineId);
    if (!current) return { result };
    return { result, diff: diffDefinitions(current.definition as unknown as CompiledDefinition, result.definition) };
  }

  async create(userId: string, source: string): Promise<PipelineDetailView> {
    const compiled = this.compileOrThrow(source);
    const pipeline = await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.pipeline.create({ data: { userId, name: compiled.definition.name } });
      const version = await tx.pipelineVersion.create({
        data: { pipelineId: created.pipelineId, version: 1, definition: toJson(compiled.definition), policy: toJson(compiled.policy) },
      });
      return tx.pipeline.update({ where: { pipelineId: created.pipelineId }, data: { currentVersionId: version.pipelineVersionId } });
    });
    return this.get(userId, pipeline.pipelineId);
  }

  /** Saves a new version (n+1) with a change summary. Refuses a source that changes nothing. */
  async addVersion(userId: string, pipelineId: string, source: string): Promise<PipelineDetailView> {
    const compiled = this.compileOrThrow(source);
    const current = await this.currentVersion(userId, pipelineId);
    if (!current) throw new NotFoundException();
    const diff = diffDefinitions(current.definition as unknown as CompiledDefinition, compiled.definition);
    if (diff.changes.length === 0) throw new UnprocessableEntityException("No changes compared to the current version");

    try {
      await this.prisma.client.$transaction(async (tx) => {
        const version = await tx.pipelineVersion.create({
          data: {
            pipelineId,
            version: current.version + 1,
            definition: toJson(compiled.definition),
            policy: toJson(compiled.policy),
            changeSummary: diff.summary,
          },
        });
        await tx.pipeline.update({
          where: { pipelineId },
          data: { currentVersionId: version.pipelineVersionId, name: compiled.definition.name },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("Another version was saved at the same time; reload and try again");
      }
      throw error;
    }
    // The new version may have another trigger.
    await this.queue.requestScheduleSync();
    return this.get(userId, pipelineId);
  }

  /** Enabling puts the pipeline on its schedule (the worker syncs pg-boss schedules); disabling takes it off. */
  async update(userId: string, pipelineId: string, body: UpdatePipelineRequest): Promise<PipelineDetailView> {
    const updated = await this.prisma.client.pipeline.updateMany({ where: { pipelineId, userId }, data: body });
    if (updated.count === 0) throw new NotFoundException();
    if (body.enabled !== undefined) await this.queue.requestScheduleSync();
    return this.get(userId, pipelineId);
  }

  async list(userId: string): Promise<PipelineSummaryView[]> {
    const pipelines = await this.prisma.client.pipeline.findMany({ where: { userId }, orderBy: { name: "asc" } });
    const versions = await this.versionNumbers(pipelines.map((p) => p.currentVersionId));
    return pipelines.map((p) => summary(p, versions.get(p.currentVersionId ?? "") ?? null));
  }

  async get(userId: string, pipelineId: string): Promise<PipelineDetailView> {
    const pipeline = await this.prisma.client.pipeline.findFirst({
      where: { pipelineId, userId },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    if (!pipeline) throw new NotFoundException();
    const current = pipeline.versions.find((v) => v.pipelineVersionId === pipeline.currentVersionId) ?? null;
    return {
      ...summary(pipeline, current?.version ?? null),
      current: current ? versionView(current) : null,
      versions: pipeline.versions.map(versionSummary),
    };
  }

  async getVersion(userId: string, pipelineId: string, version: number): Promise<PipelineVersionView> {
    const row = await this.prisma.client.pipelineVersion.findFirst({ where: { pipelineId, version, pipeline: { userId } } });
    if (!row) throw new NotFoundException();
    return versionView(row);
  }

  private compileOrThrow(source: string): Compiled {
    const result = this.compiler.compileText(source);
    if (!result.ok) throw new BadRequestException({ message: "The pipeline doesn't compile", errors: result.errors });
    return result;
  }

  private async currentVersion(userId: string, pipelineId: string): Promise<PipelineVersion | null> {
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId }, select: { currentVersionId: true } });
    if (!pipeline?.currentVersionId) return null;
    return this.prisma.client.pipelineVersion.findUnique({ where: { pipelineVersionId: pipeline.currentVersionId } });
  }

  private async versionNumbers(ids: (string | null)[]): Promise<Map<string, number>> {
    const rows = await this.prisma.client.pipelineVersion.findMany({
      where: { pipelineVersionId: { in: ids.filter((id): id is string => id !== null) } },
      select: { pipelineVersionId: true, version: true },
    });
    return new Map(rows.map((r) => [r.pipelineVersionId, r.version]));
  }
}

function toJson(value: CompiledDefinition | CompiledPolicy): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function summary(
  p: { pipelineId: string; name: string; enabled: boolean; essential: boolean; dateCreated: Date; dateUpdated: Date },
  currentVersion: number | null,
): PipelineSummaryView {
  return {
    pipelineId: p.pipelineId,
    name: p.name,
    enabled: p.enabled,
    essential: p.essential,
    currentVersion,
    dateCreated: p.dateCreated.toISOString(),
    dateUpdated: p.dateUpdated.toISOString(),
  };
}

function versionSummary(v: PipelineVersion): PipelineVersionSummaryView {
  return {
    pipelineVersionId: v.pipelineVersionId,
    version: v.version,
    changeSummary: v.changeSummary,
    dateCreated: v.dateCreated.toISOString(),
  };
}

function versionView(v: PipelineVersion): PipelineVersionView {
  return {
    ...versionSummary(v),
    definition: v.definition as unknown as CompiledDefinition,
    policy: v.policy as unknown as CompiledPolicy,
  };
}
