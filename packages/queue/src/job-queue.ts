import PgBoss from "pg-boss";
import { QUEUE_DEFINITIONS, QUEUES, type RunJob } from "./queues";

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

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 30_000 });
  }
}
