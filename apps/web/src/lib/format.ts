import { type ProposalStatusName, type RunStatusName, type StepStatusName } from "@realentity/storm-shared";

const DATE_TIME = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? DATE_TIME.format(new Date(iso)) : "—";
}

/** LLM cost: small amounts keep four decimals (a classify step costs fractions of a cent). */
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0";
  return amount < 1 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

/** "1.2 s", "3 min 5 s"; empty while still going. */
export function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt || !finishedAt) return "";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export type Tone = "green" | "red" | "yellow" | "blue" | "azure" | "secondary" | "orange";

const TONES: Record<RunStatusName | StepStatusName | ProposalStatusName, Tone> = {
  QUEUED: "secondary",
  RUNNING: "blue",
  WAITING_FOR_USER: "yellow",
  WAITING: "yellow",
  DONE: "green",
  FAILED: "red",
  ABORTED: "orange",
  PENDING: "secondary",
  SKIPPED: "secondary",
  PREVIEW: "azure",
  PENDING_REVIEW: "yellow",
  APPROVED: "blue",
  EXECUTING: "blue",
  REJECTED: "orange",
  EXPIRED: "secondary",
};

export function statusTone(status: string): Tone {
  if (status === DONE_WITH_FAILURES) return "orange";
  return (TONES as Record<string, Tone | undefined>)[status] ?? "secondary";
}

/** M54-T5: a run that is done, with items that failed and didn't stop it: "done with failures". */
export const DONE_WITH_FAILURES = "DONE_WITH_FAILURES";

/** A run's status as it is shown: done with failures when some of its items failed. */
export function runStatus(run: { status: string; failedItems: number }): string {
  return run.status === "DONE" && run.failedItems > 0 ? DONE_WITH_FAILURES : run.status;
}

/** "WAITING_FOR_USER" → "waiting for you". */
export function statusLabel(status: string): string {
  if (status === "WAITING_FOR_USER") return "waiting for you";
  if (status === "PENDING_REVIEW") return "waiting for you";
  return status.toLowerCase().replace(/_/g, " ");
}
