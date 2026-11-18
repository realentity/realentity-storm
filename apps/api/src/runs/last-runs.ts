import { type LastRunView, type RunStatusName } from "@realentity/storm-shared";
import { type PrismaService } from "../database/prisma.service";

/** Each of the user's pipelines' latest real run (dry runs aside), by pipeline. */
export async function lastRuns(prisma: PrismaService, userId: string): Promise<Map<string, LastRunView>> {
  const rows = await prisma.client.$queryRaw<{ pipelineId: string; runId: string; status: RunStatusName; failedSteps: number; startedAt: Date }[]>`
    SELECT DISTINCT ON (v."pipelineId")
      v."pipelineId", r."runId", r."status"::text AS status, r."startedAt",
      (SELECT COUNT(*)::int FROM "Steps" s WHERE s."runId" = r."runId" AND s."status" = 'FAILED') AS "failedSteps"
    FROM "Runs" r
    JOIN "PipelineVersions" v ON v."pipelineVersionId" = r."pipelineVersionId"
    WHERE r."userId" = ${userId}::uuid AND r."dryRun" = false
    ORDER BY v."pipelineId", r."startedAt" DESC, r."runId" DESC`;
  return new Map(
    rows.map((row) => [
      row.pipelineId,
      {
        runId: row.runId,
        status: row.status,
        failedItems: row.status === "DONE" ? row.failedSteps : 0,
        startedAt: row.startedAt.toISOString(),
      },
    ]),
  );
}
