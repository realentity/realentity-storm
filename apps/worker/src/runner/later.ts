import { type Prisma, type PrismaClient, type ScheduledStart } from "@realentity/storm-db";
import { type EventJob, type JobQueue } from "@realentity/storm-queue";
import { isEventTrigger, type CompiledDefinition, type TriggerEventName } from "@realentity/storm-shared";
import { valueAt } from "../steps/data-steps";

/** What cancels a scheduled start: an event with these values at these dotted paths of its data. */
export interface CancelOn {
  event: TriggerEventName;
  match: Record<string, string>;
}

const textOf = (value: unknown): string => (typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "");

/** flow.later delays at most this long. */
export const MAX_DELAY_MS = 366 * 86_400_000;

/**
 * Pipelines to start later (flow.later, M14-T3). The ScheduledStart row is the truth: the queued job only wakes it at
 * its time, and starts nothing unless the row is still PENDING (claimed once). flow.cancel, an event matching
 * `cancelOn`, or a new flow.later with the same key cancel it first.
 */
export class LaterStarts {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly queue: Pick<JobQueue, "enqueueLater">,
  ) {}

  async schedule(request: {
    userId: string;
    pipeline: string;
    /** M39-T3: the pipeline's id, when the version that names it resolved it; else it is found by name. */
    pipelineId?: string;
    fireAt: Date;
    data: Record<string, unknown>;
    key?: string;
    cancelOn?: CancelOn;
    scheduledByRunId: string;
  }): Promise<{ scheduledStartId: string; replaced: number }> {
    if (request.fireAt.getTime() - Date.now() > MAX_DELAY_MS) throw new Error("flow.later waits at most a year");
    const target = await this.prisma.pipeline.findFirst({
      where: request.pipelineId ? { userId: request.userId, pipelineId: request.pipelineId } : { userId: request.userId, name: request.pipeline },
    });
    if (!target) throw new Error(`There is no pipeline named "${request.pipeline}" to start later`);
    const version = target.currentVersionId
      ? await this.prisma.pipelineVersion.findUnique({ where: { pipelineVersionId: target.currentVersionId } })
      : null;
    const trigger = (version?.definition as CompiledDefinition | undefined)?.trigger;
    if (!trigger || !isEventTrigger(trigger) || trigger.on !== "flow.later") {
      throw new Error(`"${request.pipeline}" can't be started by flow.later: its trigger must be { on: flow.later }`);
    }
    const replaced = request.key ? await this.cancel(request.userId, request.key, "replaced by a newer flow.later with the same key") : 0;
    const row = await this.prisma.scheduledStart.create({
      data: {
        userId: request.userId,
        pipelineId: target.pipelineId,
        key: request.key ?? null,
        data: request.data as Prisma.InputJsonValue,
        cancelOn: request.cancelOn ? (request.cancelOn as unknown as Prisma.InputJsonValue) : undefined,
        fireAt: request.fireAt,
        scheduledByRunId: request.scheduledByRunId,
      },
    });
    await this.queue.enqueueLater({ scheduledStartId: row.scheduledStartId }, request.fireAt);
    return { scheduledStartId: row.scheduledStartId, replaced };
  }

  /** The pending starts with this key, cancelled. */
  async cancel(userId: string, key: string, reason = "cancelled by flow.cancel"): Promise<number> {
    const { count } = await this.prisma.scheduledStart.updateMany({ where: { userId, key, status: "PENDING" }, data: { status: "CANCELLED", reason } });
    return count;
  }

  /** The pending starts an event cancels (its data has every value of their cancelOn.match). */
  async cancelByEvent(job: EventJob): Promise<number> {
    const pending = await this.prisma.scheduledStart.findMany({ where: { userId: job.userId, status: "PENDING" } });
    const hit = pending.filter((row) => {
      const on = row.cancelOn as unknown as CancelOn | null;
      return on?.event === job.event && Object.entries(on.match).every(([path, value]) => textOf(valueAt(job.data, path)) === value);
    });
    if (hit.length === 0) return 0;
    const { count } = await this.prisma.scheduledStart.updateMany({
      where: { scheduledStartId: { in: hit.map((row) => row.scheduledStartId) }, status: "PENDING" },
      data: { status: "CANCELLED", reason: `cancelled by ${job.event}` },
    });
    return count;
  }

  /** Claims a start whose time has come: the row, once, or null when it already started, was cancelled or isn't due. */
  async claim(scheduledStartId: string): Promise<ScheduledStart | null> {
    const { count } = await this.prisma.scheduledStart.updateMany({
      where: { scheduledStartId, status: "PENDING", fireAt: { lte: new Date() } },
      data: { status: "STARTED" },
    });
    return count ? this.prisma.scheduledStart.findUniqueOrThrow({ where: { scheduledStartId } }) : null;
  }

  async finish(scheduledStartId: string, outcome: { runId: string } | { skipped: string }): Promise<void> {
    await this.prisma.scheduledStart.update({
      where: { scheduledStartId },
      data: "runId" in outcome ? { runId: outcome.runId } : { status: "SKIPPED", reason: outcome.skipped },
    });
  }
}
