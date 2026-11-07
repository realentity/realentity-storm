import { pipelineCost } from "../runs/run-costs";
import { Prisma, type PipelineVersion } from "@ai-me/db";
import { JobQueue } from "@ai-me/queue";
import {
  canonicalJson,
  type CompiledDefinition,
  type CompiledPolicy,
  type CompilePipelineResponse,
  type CompileIssue,
  type CompileResult,
  type DryRunPipelineResponse,
  withCurrentNames,
  type PipelineDetailView,
  type PipelineSummaryView,
  type PipelineVersionSummaryView,
  type PipelineVersionView,
  type UpdatePipelineRequest,
} from "@ai-me/shared";
import { diffDefinitions } from "@ai-me/steps";
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { AppsService } from "../apps/apps.service";
import { ControlsService } from "../controls/controls.service";
import { PrismaService } from "../database/prisma.service";
import { RunsService } from "../runs/runs.service";

type Compiled = Extract<CompileResult, { ok: true }>;

type Tx = Prisma.TransactionClient;

/**
 * Pipelines and their versions (README §2.1–2.2). Every save compiles the source; a version stores the compiled
 * definition and policy, which is what runs execute. Saved versions are immutable; changes create a new one.
 * Before saving, a source can be dry-run as the pipeline's draft: one per pipeline, numbered after the latest saved
 * version, never run for real or on a schedule. Saving the draft's source keeps the draft (and its dry runs) as the
 * new version; saving anything else replaces it.
 */
@Injectable()
export class PipelinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueue,
    private readonly runs: RunsService,
    private readonly controls: ControlsService,
    private readonly apps: AppsService,
  ) {}

  /** Compiles without saving, for the review screen; with a pipeline, also the diff against its current version. */
  async compile(userId: string, source: string, pipelineId?: string): Promise<CompilePipelineResponse> {
    const result = await this.apps.compileSource(userId, source);
    if (result.ok) result.warnings.push(...(await this.calendarWarnings(userId, result.definition)));
    if (!result.ok || !pipelineId) return { result };
    const current = await this.currentVersion(userId, pipelineId);
    if (!current) return { result };
    // M39-T5: a rename says what follows it.
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } });
    const renamed =
      pipeline && result.definition.name !== pipeline.name
        ? { from: pipeline.name, to: result.definition.name, followers: await this.apps.referrersOf(userId, pipelineId) }
        : undefined;
    return { result, diff: diffDefinitions(current.definition as unknown as CompiledDefinition, result.definition), ...(renamed ? { renamed } : {}) };
  }

  /** `builderChatId`: the builder chat the source came from (README §2.1), kept with the version. */
  async create(userId: string, source: string, builderChatId?: string): Promise<PipelineDetailView> {
    const compiled = await this.compileOrThrow(userId, source);
    await this.assertNameFree(userId, compiled.definition.name);
    const pipeline = await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.pipeline.create({ data: { userId, name: compiled.definition.name } });
      const version = await tx.pipelineVersion.create({
        data: {
          pipelineId: created.pipelineId,
          version: 1,
          definition: toJson(compiled.definition),
          policy: toJson(compiled.policy),
          builderChatId,
          savedAt: new Date(),
        },
      });
      return tx.pipeline.update({ where: { pipelineId: created.pipelineId }, data: { currentVersionId: version.pipelineVersionId } });
    });
    return this.get(userId, pipeline.pipelineId);
  }

  /**
   * Saves the next version with a change summary (v1 for a pipeline that only had a draft). Refuses a source that
   * changes nothing.
   */
  async addVersion(userId: string, pipelineId: string, source: string, builderChatId?: string): Promise<PipelineDetailView> {
    const compiled = await this.compileOrThrow(userId, source);
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } });
    if (!pipeline) throw new NotFoundException();
    await this.assertNameFree(userId, compiled.definition.name, pipelineId);
    const current = await this.currentVersion(userId, pipelineId);
    const diff = current ? diffDefinitions(current.definition as unknown as CompiledDefinition, compiled.definition) : null;
    if (diff?.changes.length === 0) throw new UnprocessableEntityException("No changes compared to the current version");

    await this.guardConcurrentSave(() =>
      this.prisma.client.$transaction(async (tx) => {
        const draft = await this.draftOf(tx, pipelineId);
        const now = new Date();
        let saved: PipelineVersion;
        if (draft && sameDefinition(draft, compiled)) {
          // What I dry-ran is what I save: the draft and its dry runs become this version.
          saved = await tx.pipelineVersion.update({
            where: { pipelineVersionId: draft.pipelineVersionId },
            data: { savedAt: now, changeSummary: diff?.summary ?? null, ...(builderChatId ? { builderChatId } : {}) },
          });
        } else {
          if (draft) await this.deleteDraft(tx, draft);
          saved = await tx.pipelineVersion.create({
            data: {
              pipelineId,
              version: (current?.version ?? 0) + 1,
              definition: toJson(compiled.definition),
              policy: toJson(compiled.policy),
              changeSummary: diff?.summary ?? null,
              builderChatId,
              savedAt: now,
            },
          });
        }
        await tx.pipeline.update({
          where: { pipelineId },
          data: { currentVersionId: saved.pipelineVersionId, name: compiled.definition.name },
        });
      }),
    );
    // The new version may have another trigger.
    await this.queue.requestScheduleSync();
    return this.get(userId, pipelineId);
  }

  /**
   * Stores the source as the pipeline's draft (replacing an older draft and its dry runs) and starts a dry run of
   * it. Without a pipeline, creates one that has only this draft until it is saved. M37-T3: with `stopAfter`, the run
   * stops after that step (try up to here).
   */
  async dryRun(userId: string, source: string, pipelineId?: string, stopAfter?: string): Promise<DryRunPipelineResponse> {
    const compiled = await this.compileOrThrow(userId, source);
    if (stopAfter !== undefined && !compiled.definition.steps.some((s) => s.id === stopAfter)) {
      throw new BadRequestException(`The pipeline has no step "${stopAfter}"`);
    }
    await this.controls.assertNotPaused(userId);
    const draft = await this.guardConcurrentSave(() =>
      this.prisma.client.$transaction(async (tx) => {
        const pipeline = pipelineId
          ? await tx.pipeline.findFirst({ where: { pipelineId, userId } })
          : await tx.pipeline.create({ data: { userId, name: compiled.definition.name } });
        if (!pipeline) throw new NotFoundException();
        const current = pipeline.currentVersionId
          ? await tx.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: pipeline.currentVersionId } })
          : null;
        const old = await this.draftOf(tx, pipeline.pipelineId);
        if (old) await this.deleteDraft(tx, old);
        return tx.pipelineVersion.create({
          data: {
            pipelineId: pipeline.pipelineId,
            version: (current?.version ?? 0) + 1,
            definition: toJson(compiled.definition),
            policy: toJson(compiled.policy),
            changeSummary: current
              ? diffDefinitions(current.definition as unknown as CompiledDefinition, compiled.definition).summary
              : null,
          },
        });
      }),
    );
    const run = await this.runs.startVersion(userId, draft.pipelineVersionId, true, "manual", undefined, stopAfter);
    return { pipeline: await this.get(userId, draft.pipelineId), run };
  }

  /** Discards the draft and its dry runs; a pipeline that was never saved goes with it. */
  async discardDraft(userId: string, pipelineId: string): Promise<void> {
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } });
    if (!pipeline) throw new NotFoundException();
    await this.prisma.client.$transaction(async (tx) => {
      const draft = await this.draftOf(tx, pipelineId);
      if (draft) await this.deleteDraft(tx, draft);
      if (!pipeline.currentVersionId) await tx.pipeline.delete({ where: { pipelineId } });
    });
  }

  /** Enabling puts the pipeline on its schedule (the worker syncs pg-boss schedules); disabling takes it off. */
  async update(userId: string, pipelineId: string, body: UpdatePipelineRequest): Promise<PipelineDetailView> {
    if (body.enabled) {
      const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId } });
      if (pipeline && !pipeline.currentVersionId) throw new ConflictException("Save the pipeline before enabling it");
    }
    const updated = await this.prisma.client.pipeline.updateMany({ where: { pipelineId, userId }, data: body });
    if (updated.count === 0) throw new NotFoundException();
    if (body.enabled !== undefined) await this.queue.requestScheduleSync();
    return this.get(userId, pipelineId);
  }

  async list(userId: string): Promise<PipelineSummaryView[]> {
    const pipelines = await this.prisma.client.pipeline.findMany({
      where: { userId },
      include: { versions: { where: { savedAt: null }, select: { pipelineVersionId: true } } },
      orderBy: { name: "asc" },
    });
    const versions = await this.versionNumbers(pipelines.map((p) => p.currentVersionId));
    return pipelines.map((p) => summary(p, versions.get(p.currentVersionId ?? "") ?? null, p.versions.length > 0));
  }

  async get(userId: string, pipelineId: string): Promise<PipelineDetailView> {
    const pipeline = await this.prisma.client.pipeline.findFirst({
      where: { pipelineId, userId },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    if (!pipeline) throw new NotFoundException();
    const current = pipeline.versions.find((v) => v.pipelineVersionId === pipeline.currentVersionId) ?? null;
    const draft = pipeline.versions.find((v) => !v.savedAt) ?? null;
    // M39-T4: the current version and the draft with the names things have now (the editor opens them); history as saved.
    const names = await this.apps.currentNames(userId);
    const now = (v: PipelineVersion) => {
      const view = versionView(v);
      return { ...view, definition: withCurrentNames(view.definition, names, pipeline.currentVersionId ? pipeline.name : undefined) };
    };
    return {
      ...summary(pipeline, current?.version ?? null, draft !== null),
      current: current ? now(current) : null,
      draft: draft ? now(draft) : null,
      versions: pipeline.versions.filter((v) => v.savedAt).map(versionSummary),
      cost: await pipelineCost(this.prisma, pipelineId, (current?.definition as CompiledDefinition | undefined) ?? null),
    };
  }

  async getVersion(userId: string, pipelineId: string, version: number): Promise<PipelineVersionView> {
    const row = await this.prisma.client.pipelineVersion.findFirst({
      where: { pipelineId, version, savedAt: { not: null }, pipeline: { userId } },
    });
    if (!row) throw new NotFoundException();
    return versionView(row);
  }

  private async compileOrThrow(userId: string, source: string): Promise<Compiled> {
    const result = await this.apps.compileSource(userId, source);
    if (!result.ok) throw new BadRequestException({ message: "The pipeline doesn't compile", errors: result.errors });
    return result;
  }

  /** Calendar steps while Google Calendar isn't connected (M14-T1): said on the review screen, before a run waits for it. */
  private async calendarWarnings(userId: string, definition: CompiledDefinition): Promise<CompileIssue[]> {
    const index = definition.steps.findIndex((step) => step.type.startsWith("calendar."));
    if (index < 0) return [];
    const google = await this.prisma.client.googleConnection.findUnique({ where: { userId }, select: { status: true } });
    if (google?.status === "CONNECTED") return [];
    const state = google ? "needs reconnecting" : "isn't connected";
    return [{ path: `steps[${index}]`, message: `Google Calendar ${state}: connect it in Settings, or the run waits for it there` }];
  }

  private async currentVersion(userId: string, pipelineId: string): Promise<PipelineVersion | null> {
    const pipeline = await this.prisma.client.pipeline.findFirst({ where: { pipelineId, userId }, select: { currentVersionId: true } });
    if (!pipeline?.currentVersionId) return null;
    return this.prisma.client.pipelineVersion.findUnique({ where: { pipelineVersionId: pipeline.currentVersionId } });
  }

  private draftOf(tx: Tx, pipelineId: string): Promise<PipelineVersion | null> {
    return tx.pipelineVersion.findFirst({ where: { pipelineId, savedAt: null } });
  }

  /** A draft's runs are dry runs (previews); they go with it. */
  private async deleteDraft(tx: Tx, draft: PipelineVersion): Promise<void> {
    await tx.run.deleteMany({ where: { pipelineVersionId: draft.pipelineVersionId } });
    await tx.pipelineVersion.delete({ where: { pipelineVersionId: draft.pipelineVersionId } });
  }

  /** Two saves (or drafts) at once collide on the version number. */
  /**
   * M39-T1: a saved pipeline's name is its own (other pipelines, buttons and the builder name it). A draft that was
   * never saved may share one: it gets it only when saved.
   */
  private async assertNameFree(userId: string, name: string, pipelineId?: string): Promise<void> {
    const taken = await this.prisma.client.pipeline.findFirst({
      where: { userId, name, currentVersionId: { not: null }, ...(pipelineId ? { pipelineId: { not: pipelineId } } : {}) },
    });
    if (taken) throw new ConflictException(`There is already a pipeline named "${name}": give this one another name`);
  }

  private async guardConcurrentSave<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("Another version was saved at the same time; reload and try again");
      }
      throw error;
    }
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

function sameDefinition(version: PipelineVersion, compiled: Compiled): boolean {
  return canonicalJson(version.definition) === canonicalJson(compiled.definition);
}

function summary(
  p: { pipelineId: string; name: string; enabled: boolean; essential: boolean; dateCreated: Date; dateUpdated: Date },
  currentVersion: number | null,
  hasDraft: boolean,
): PipelineSummaryView {
  return {
    pipelineId: p.pipelineId,
    name: p.name,
    enabled: p.enabled,
    essential: p.essential,
    currentVersion,
    hasDraft,
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
