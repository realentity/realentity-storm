import { z } from "zod";

/** A report from one of the server's jobs (M26): POST /hooks/health with the x-aime-health-token header. */
export const HealthReportSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]{1,40}$/, "lowercase letters, digits and -, e.g. backup"),
    ok: z.boolean(),
    detail: z.string().max(2000).default(""),
    /** A report older than this is a problem itself: the job stopped running. */
    maxAgeHours: z.number().int().min(1).max(24 * 45).default(26),
  })
  .strict();
export type HealthReport = z.input<typeof HealthReportSchema>;

export interface HealthCheckView {
  name: string;
  ok: boolean;
  detail: string;
  reportedAt: string;
  maxAgeHours: number;
  /** No report for longer than maxAgeHours. */
  stale: boolean;
  problem: boolean;
}

export interface HealthView {
  worker: { state: "up" | "down" | "unknown"; lastSeenAt: string | null };
  checks: HealthCheckView[];
}
