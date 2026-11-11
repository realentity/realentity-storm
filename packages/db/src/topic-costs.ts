import { type PrismaClient } from "./generated/prisma/client";

/**
 * A topic's upkeep cost (M44-T5): what the topic steps spent, shared out among the topics they were for, by day. Only
 * where the money went: the budget counts the steps themselves (llmSpendSince).
 */
export async function addTopicCosts(
  prisma: PrismaClient,
  userId: string,
  source: string,
  shares: Map<string, number>,
  at = new Date(),
): Promise<void> {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  for (const [topicId, costUsd] of shares) {
    if (!(costUsd > 0)) continue;
    await prisma.topicCost.upsert({
      where: { topicId_day_source: { topicId, day, source } },
      create: { userId, topicId, day, source, costUsd },
      update: { costUsd: { increment: costUsd } },
    });
  }
}

/** What each of the user's topics cost since `since`: its upkeep and its backfills. The most first. */
export async function topicCostsSince(
  prisma: PrismaClient,
  userId: string,
  since: Date,
): Promise<{ topicId: string; name: string; costUsd: number }[]> {
  const rows = await prisma.$queryRaw<{ topicId: string; name: string; cost: string }[]>`
    SELECT t."topicId", t."name"::text AS "name", SUM(c.cost)::text AS cost
    FROM (
      SELECT "topicId", "costUsd"::numeric AS cost FROM "TopicCosts" WHERE "userId" = ${userId}::uuid AND "day" >= ${since}::date
      UNION ALL
      SELECT "topicId", ("llmUsage"->>'costUsd')::numeric FROM "TopicBackfills"
      WHERE "userId" = ${userId}::uuid AND "dateCreated" >= ${since} AND "llmUsage" ? 'costUsd'
    ) c JOIN "Topics" t ON t."topicId" = c."topicId"
    GROUP BY 1, 2
    HAVING SUM(c.cost) > 0
    ORDER BY SUM(c.cost) DESC`;
  return rows.map((r) => ({ topicId: r.topicId, name: r.name, costUsd: Number(r.cost) }));
}

/** Shares a cost evenly among topics (a call about two topics: half each). */
export function share(into: Map<string, number>, topicIds: string[], costUsd: number): void {
  const ids = [...new Set(topicIds)];
  if (!ids.length || !(costUsd > 0)) return;
  for (const id of ids) into.set(id, (into.get(id) ?? 0) + costUsd / ids.length);
}
