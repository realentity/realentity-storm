import PgBoss from "pg-boss";
import {
  QUEUE_DEFINITIONS,
  QUEUES,
  type EventJob,
  type LearningJob,
  type ReflectionJob,
  type ReflectionPollJob,
  type RunJob,
  type WebhookJob,
} from "./queues";

export interface JobQueueOptions {
  connectionString: string;
  /** The worker also fires cron schedules and runs pg-boss maintenance; the api only sends jobs. */
  role: "worker" | "api";
  onError?: (error: Error) => void;
}

/** pg-boss keeps its tables in their own schema, next to the application's. */
const SCHEMA = "pgboss";

/** The job queue (pg-boss in Postgres, README §4). */
export class JobQueue {
  private constructor(readonly boss: PgBoss) {}

  static async start(options: JobQueueOptions): Promise<JobQueue> {
    const worker = options.role === "worker";
    const boss = new PgBoss({
      connectionString: options.connectionString,
      schema: SCHEMA,
      application_name: `ai-me-${options.role}`,
      max: worker ? 4 : 2,
      schedule: worker,
      supervise: worker,
    });
    boss.on("error", options.onError ?? (() => undefined));
    await boss.start();
    for (const queue of QUEUE_DEFINITIONS) await boss.createQueue(queue.name, queue);
    return new JobQueue(boss);
  }

  /** Advances a run: now, or once a rate limit allows (`startAfter`). Headed runs go to the serialized queue. */
  async enqueueRun(run: { runId: string; headed: boolean }, startAfter?: Date): Promise<void> {
    const data: RunJob = { runId: run.runId };
    await this.boss.send(run.headed ? QUEUES.runsHeaded : QUEUES.runs, data, startAfter ? { startAfter } : {});
  }

  async requestScheduleSync(): Promise<void> {
    await this.boss.send(QUEUES.syncSchedules, {});
  }

  /** An approved proposal: the worker turns its approved text into a few-shot example. */
  async enqueueLearning(proposalId: string): Promise<void> {
    const data: LearningJob = { proposalId };
    await this.boss.send(QUEUES.learning, data);
  }

  /** A reflection now (Rules page), besides the nightly one. */
  async requestReflection(userId: string): Promise<void> {
    const data: ReflectionJob = { userId };
    await this.boss.send(QUEUES.reflection, data);
  }

  async pollReflection(reflectionId: string, startAfter: Date): Promise<void> {
    const data: ReflectionPollJob = { reflectionId };
    await this.boss.send(QUEUES.reflectionPoll, data, { startAfter });
  }

  /** Something happened that may start pipelines (M12-T1). */
  async enqueueEvent(event: EventJob): Promise<void> {
    await this.boss.send(QUEUES.events, event);
  }

  /** A webhook call, for the worker to check and run (M12-T2). */
  async enqueueWebhook(call: WebhookJob): Promise<void> {
    await this.boss.send(QUEUES.webhooks, call);
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 30_000 });
  }
}
