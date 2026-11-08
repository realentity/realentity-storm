import { fireCount, isScheduled } from "@realentity/storm-queue";
import { type CompiledDefinition, type PipelineCostView } from "@realentity/storm-shared";
import { type PrismaService } from "../database/prisma.service";

const DAY_MS = 86_400_000;
/** The window of a pipeline's cost, and the month an estimate is for. */
export const COST_DAYS = 30;
/** A schedule firing more often than this in a month is counted up to it (every minute: 43 200). */
const MAX_FIRES = 10_000;

/** Each run's LLM cost: the sum of its steps' usage. */
export async function runCosts(prisma: PrismaService, runIds: string[]): Promise<Map<string, number>> {
  if (runIds.length === 0) return new Map();
  const rows = await prisma.client.$queryRaw<{ runId: string; cost: number }[]>`
    SELECT "runId", COALESCE(SUM(("llmUsage"->>'costUsd')::float), 0) AS cost
    FROM "Steps" WHERE "runId" = ANY(${runIds}::uuid[]) GROUP BY "runId"`;
  return new Map(rows.map((r) => [r.runId, round(Number(r.cost))]));
}

/**
 * What a pipeline cost in the last COST_DAYS (M17-T3), per run, and per month on its schedule: the average of its
 * real runs (of its dry runs while it has none) times the times the schedule fires in the next 30 days.
 */
export async function pipelineCost(prisma: PrismaService, pipelineId: string, definition: CompiledDefinition | null, now = new Date()): Promise<PipelineCostView> {
  const since = new Date(now.getTime() - COST_DAYS * DAY_MS);
  const rows = await prisma.client.$queryRaw<{ dryRun: boolean; cost: number }[]>`
    SELECT r."dryRun", COALESCE(SUM((s."llmUsage"->>'costUsd')::float), 0) AS cost
    FROM "Runs" r
    JOIN "PipelineVersions" v ON v."pipelineVersionId" = r."pipelineVersionId"
    LEFT JOIN "Steps" s ON s."runId" = r."runId"
    WHERE v."pipelineId" = ${pipelineId}::uuid AND r."startedAt" >= ${since}
    GROUP BY r."runId", r."dryRun"`;
  const real = rows.filter((r) => !r.dryRun).map((r) => Number(r.cost));
  const dry = rows.filter((r) => r.dryRun).map((r) => Number(r.cost));
  const sample = real.length ? real : dry;
  const perRunUsd = sample.length ? round(sample.reduce((a, b) => a + b, 0) / sample.length) : null;
  const trigger = definition?.trigger;
  const runsPerMonth = trigger && isScheduled(trigger) ? fireCount(trigger, now, new Date(now.getTime() + COST_DAYS * DAY_MS), MAX_FIRES) : null;
  return {
    days: COST_DAYS,
    runs: rows.length,
    dryRuns: dry.length,
    totalUsd: round([...real, ...dry].reduce((a, b) => a + b, 0)),
    perRunUsd,
    runsPerMonth,
    perMonthUsd: perRunUsd !== null && runsPerMonth !== null ? round(perRunUsd * runsPerMonth) : null,
  };
}

const round = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;
