import { type PrismaClient, type RunStatus } from "@ai-me/db";
import { type CompiledDefinition } from "@ai-me/shared";
import {
  isScheduled,
  QUEUES,
  REFLECTION_SCHEDULE,
  type JobQueue,
  type LearningJob,
  type ReflectionJob,
  type ReflectionPollJob,
  type RunJob,
  type ScheduleTrigger,
  type TriggerJob,
} from "@ai-me/queue";
import { Logger } from "@nestjs/common";
import { type Learning } from "../learning/learning";
import { type Reflector } from "../learning/reflection";
import { type PipelineRunner } from "../runner/pipeline-runner";

export interface ConsumeOptions {
  /** Headless runs advanced at once by this process. Headed runs are always one at a time. */
  concurrency?: number;
  pollingIntervalSeconds?: number;
}

/**
 * What the worker does with each queue (README §2.6): advance runs, start scheduled runs, keep pg-boss schedules in
 * line with the enabled pipelines. Everything is idempotent: the runner claims a run before advancing it.
 */
export class JobHandlers {
  private readonly logger = new Logger(JobHandlers.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runner: PipelineRunner,
    private readonly queue: JobQueue,
    /** README §8; the runner's tests leave them out. */
    private readonly learning?: Learning,
    private readonly reflector?: Reflector,
  ) {}

  async consume(options: ConsumeOptions = {}): Promise<void> {
    const work = { batchSize: 1, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 };
    const boss = this.queue.boss;
    for (let i = 0; i < (options.concurrency ?? 2); i++) {
      await boss.work<RunJob>(QUEUES.runs, work, async ([job]) => job && this.advance(job.data.runId));
    }
    await boss.work<RunJob>(QUEUES.runsHeaded, work, async ([job]) => job && this.advance(job.data.runId));
    await boss.work<TriggerJob>(QUEUES.trigger, work, async ([job]) => job && this.trigger(job.data.pipelineId));
    await boss.work(QUEUES.syncSchedules, work, () => this.syncSchedules());
    const { learning, reflector } = this;
    if (learning) {
      await boss.work<LearningJob>(QUEUES.learning, work, async ([job]) => job && learning.fromProposal(job.data.proposalId));
    }
    if (reflector) {
      await boss.work<ReflectionJob>(QUEUES.reflection, work, async ([job]) => job && reflector.run(job.data.userId));
      await boss.work<ReflectionPollJob>(QUEUES.reflectionPoll, work, async ([job]) => job && reflector.check(job.data.reflectionId));
      await boss.schedule(QUEUES.reflection, REFLECTION_SCHEDULE.cron, {}, { tz: REFLECTION_SCHEDULE.tz });
    }
  }

  /** Advances a run; one held back by a rate limit is sent again for when the limit allows. */
  async advance(runId: string): Promise<RunStatus> {
    const status = await this.runner.advance(runId);
    if (status === "QUEUED") {
      const run = await this.prisma.run.findUniqueOrThrow({ where: { runId } });
      if (run.resumeAt) await this.queue.enqueueRun(run, run.resumeAt);
    }
    return status;
  }

  /** A schedule fired: a run on the pipeline's current version, unless it was disabled or the kill switch is on. */
  async trigger(pipelineId: string): Promise<string | null> {
    const pipeline = await this.prisma.pipeline.findUnique({ where: { pipelineId }, include: { user: { include: { settings: true } } } });
    if (!pipeline?.enabled || !pipeline.currentVersionId) return null;
    if (pipeline.user.settings?.paused) {
      this.logger.log(`Kill switch is on: scheduled run of "${pipeline.name}" skipped`);
      return null;
    }
    const runId = await this.runner.start(pipeline.currentVersionId, { trigger: "schedule" });
    await this.queue.enqueueRun(await this.prisma.run.findUniqueOrThrow({ where: { runId } }));
    return runId;
  }

  /** pg-boss schedules = the enabled pipelines whose current version has a schedule trigger (key: pipelineId). */
  async syncSchedules(): Promise<void> {
    const pipelines = await this.prisma.pipeline.findMany({ where: { enabled: true, currentVersionId: { not: null } } });
    const versions = await this.prisma.pipelineVersion.findMany({
      where: { pipelineVersionId: { in: pipelines.map((p) => p.currentVersionId!) } },
    });
    const wanted = new Map<string, ScheduleTrigger>();
    for (const version of versions) {
      const trigger = (version.definition as unknown as CompiledDefinition).trigger;
      if (isScheduled(trigger)) wanted.set(version.pipelineId, trigger);
    }

    const boss = this.queue.boss;
    // getSchedules(name) only returns the schedule without a key: list all and filter.
    for (const schedule of await boss.getSchedules()) {
      if (schedule.name === QUEUES.trigger && !wanted.has(schedule.key)) await boss.unschedule(QUEUES.trigger, schedule.key);
    }
    for (const [pipelineId, trigger] of wanted) {
      const data: TriggerJob = { pipelineId };
      await boss.schedule(QUEUES.trigger, trigger.schedule, data, { tz: trigger.tz, key: pipelineId });
    }
  }

  /**
   * At startup: runs interrupted by a stop or crash continue from their last completed step (README §2.6), and every
   * queued run gets a job again (a duplicate is harmless).
   */
  async recover(): Promise<void> {
    const interrupted = await this.runner.recoverInterrupted();
    if (interrupted.length > 0) this.logger.log(`Resuming ${interrupted.length} interrupted run(s)`);
    for (const run of await this.prisma.run.findMany({ where: { status: "QUEUED" } })) {
      await this.queue.enqueueRun(run, run.resumeAt ?? undefined);
    }
    await this.reflector?.recover();
    // Examples kept while OpenAI was unavailable, or made by another embedding model.
    await this.learning?.backfill().then(
      (n) => n > 0 && this.logger.log(`Embedded ${n} example(s)`),
      (error: Error) => this.logger.warn(`Examples not embedded yet: ${error.message}`),
    );
  }
}
