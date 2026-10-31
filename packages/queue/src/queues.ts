import type PgBoss from "pg-boss";

/** Queue names. The api sends to them; the worker consumes them. */
export const QUEUES = {
  /** Advance a run as far as it goes (headless steps only). */
  runs: "runs",
  /** Advance a run that needs the headed browser: one at a time across all workers (one virtual display). */
  runsHeaded: "runs-headed",
  /** A pipeline's schedule fired: start a run on its current version. */
  trigger: "pipeline-trigger",
  /** Pipelines were enabled, disabled or changed: reconcile pg-boss schedules with the database. */
  syncSchedules: "schedules-sync",
  /** I approved a proposal: its approved text becomes a few-shot example (README §8). */
  learning: "learning",
  /** Nightly, or when I ask: send my recent edits and rejections to Claude as a batch. */
  reflection: "reflection",
  /** Check a submitted reflection batch; saves its suggestions once it has ended. */
  reflectionPoll: "reflection-poll",
} as const;

export interface RunJob {
  runId: string;
}

export interface TriggerJob {
  pipelineId: string;
}

/** The nightly reflection: after the server's 02:30 backup, before the day's first runs. */
export const REFLECTION_SCHEDULE = { cron: "30 3 * * *", tz: "Europe/Sofia" } as const;

export interface LearningJob {
  proposalId: string;
}

/** Without a userId (the nightly schedule): every user with new decisions. */
export interface ReflectionJob {
  userId?: string;
}

export interface ReflectionPollJob {
  reflectionId: string;
}

const RUN_QUEUE: Omit<PgBoss.Queue, "name"> = {
  // Duplicate jobs for one run are harmless: the runner claims a run before advancing it.
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  // A headed run can take a while; after this, pg-boss retries the job (the claim makes that safe).
  expireInSeconds: 2 * 60 * 60,
};

export const QUEUE_DEFINITIONS: PgBoss.Queue[] = [
  { name: QUEUES.runs, policy: "standard", ...RUN_QUEUE },
  // singleton: at most one active job in the queue, whichever worker process fetches it.
  { name: QUEUES.runsHeaded, policy: "singleton", ...RUN_QUEUE },
  { name: QUEUES.trigger, policy: "standard", retryLimit: 2, retryDelay: 30 },
  // short: requests coalesce while one is waiting.
  { name: QUEUES.syncSchedules, policy: "short", retryLimit: 5, retryDelay: 10 },
  { name: QUEUES.learning, policy: "standard", retryLimit: 5, retryDelay: 60, retryBackoff: true },
  // stately: one waiting and one active at a time (a second request while one waits is dropped).
  { name: QUEUES.reflection, policy: "stately", retryLimit: 2, retryDelay: 300 },
  { name: QUEUES.reflectionPoll, policy: "standard", retryLimit: 5, retryDelay: 120, retryBackoff: true },
];
