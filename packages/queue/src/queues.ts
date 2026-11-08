import { defaultTimeZone, type TriggerEventName } from "@realentity/storm-shared";
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
  /** The user approved a proposal: its approved text becomes a few-shot example (docs/design.md §8). */
  learning: "learning",
  /** Nightly, or when the user asks: send their recent edits and rejections to Claude as a batch. */
  reflection: "reflection",
  /** Check a submitted reflection batch; saves its suggestions once it has ended. */
  reflectionPoll: "reflection-poll",
  /** Nightly housekeeping: run files (screenshots, traces) past their retention. */
  maintenance: "maintenance",
  /** Something happened (a run finished, an application moved, …): start the pipelines triggered by it (M12-T1). */
  events: "pipeline-events",
  /** A webhook call the api accepted: the worker checks its signature and starts the pipeline (M12-T2). */
  webhooks: "webhooks",
  /** A flow.later start whose time has come (M14-T3); the ScheduledStart row decides whether it still runs. */
  later: "later",
  /** Sunday evening: the week on Telegram (M19-T4). */
  weeklyReview: "weekly-review",
  /** Every morning: what today needs, on Telegram (M25). */
  morningBrief: "morning-brief",
} as const;

export interface RunJob {
  runId: string;
}

export interface TriggerJob {
  pipelineId: string;
}

/** The nightly reflection: after the server's 02:30 backup, before the day's first runs. */
export const REFLECTION_SCHEDULE = { cron: "30 3 * * *", get tz() { return defaultTimeZone(); } };

/** Nightly housekeeping, after the reflection. */
export const MAINTENANCE_SCHEDULE = { cron: "15 4 * * *", get tz() { return defaultTimeZone(); } };

/** The weekly review: Sunday evening, when there's time to act on it before the week starts. */
export const WEEKLY_REVIEW_SCHEDULE = { cron: "0 19 * * 0", get tz() { return defaultTimeZone(); } };

/** The morning brief: before the day starts, after the nightly jobs. */
export const MORNING_BRIEF_SCHEDULE = { cron: "30 7 * * *", get tz() { return defaultTimeZone(); } };

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

/** Where an event came from: a run of a pipeline (to stop loops), and how deep in a chain of triggered runs. */
export interface EventSource {
  runId?: string;
  pipelineId?: string;
  /** 0 for a run that wasn't triggered by an event; a run triggered by an event at depth n is at n + 1. */
  depth: number;
}

export interface EventJob {
  userId: string;
  event: TriggerEventName;
  /** {{trigger.*}} of the runs it starts. */
  data: Record<string, unknown>;
  source: EventSource;
}

export interface WebhookJob {
  webhookId: string;
  /** The body exactly as received, base64: the signature is over these bytes. */
  body: string;
  /** X-Hub-Signature-256, for an hmac-sha256 webhook (the api already checked a token one). */
  signature: string | null;
  /** X-GitHub-Event or X-Event: {{trigger.event}}. */
  event: string | null;
  receivedAt: string;
}

export interface LaterJob {
  scheduledStartId: string;
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
  { name: QUEUES.maintenance, policy: "stately", retryLimit: 2, retryDelay: 600 },
  { name: QUEUES.weeklyReview, policy: "stately", retryLimit: 2, retryDelay: 600 },
  { name: QUEUES.morningBrief, policy: "stately", retryLimit: 2, retryDelay: 300 },
  { name: QUEUES.events, policy: "standard", retryLimit: 3, retryDelay: 30 },
  { name: QUEUES.webhooks, policy: "standard", retryLimit: 3, retryDelay: 30 },
  // Waits up to flow.later's longest delay (a year) before it may run.
  { name: QUEUES.later, policy: "standard", retryLimit: 3, retryDelay: 60, retentionSeconds: 400 * 24 * 60 * 60 },
];
