import { type PrismaClient } from "./generated/prisma/client";

/**
 * What the user's LLM calls cost since `since`: steps (Step.llmUsage), reflections (Reflection.llmUsage), builder
 * chats (BuilderMessage.llmUsage) and topic backfills (TopicBackfill.llmUsage, M43-T5).
 */
export async function llmSpendSince(prisma: PrismaClient, userId: string, since: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ spent: string | null }[]>`
    SELECT (
      COALESCE((
        SELECT SUM((s."llmUsage"->>'costUsd')::numeric)
        FROM "Steps" s JOIN "Runs" r ON r."runId" = s."runId"
        WHERE r."userId" = ${userId}::uuid AND s."startedAt" >= ${since} AND s."llmUsage" ? 'costUsd'
      ), 0) +
      COALESCE((
        SELECT SUM((f."llmUsage"->>'costUsd')::numeric)
        FROM "Reflections" f
        WHERE f."userId" = ${userId}::uuid AND f."startedAt" >= ${since} AND f."llmUsage" ? 'costUsd'
      ), 0) +
      COALESCE((
        SELECT SUM((m."llmUsage"->>'costUsd')::numeric)
        FROM "BuilderMessages" m JOIN "BuilderChats" c ON c."builderChatId" = m."builderChatId"
        WHERE c."userId" = ${userId}::uuid AND m."dateCreated" >= ${since} AND m."llmUsage" ? 'costUsd'
      ), 0) +
      COALESCE((
        SELECT SUM((b."llmUsage"->>'costUsd')::numeric)
        FROM "TopicBackfills" b
        WHERE b."userId" = ${userId}::uuid AND b."dateCreated" >= ${since} AND b."llmUsage" ? 'costUsd'
      ), 0)
    )::text AS spent`;
  return Number(rows[0]?.spent ?? 0);
}

/** One line of where the money went (M19-T3): a step type, or "reflection", "builder", "topic backfill", by the model. */
export interface LlmCostRow {
  source: string;
  /** The models of a call, in order of first use ("claude-haiku-5-5 + claude-sonnet-5-5": the fallback answered too). */
  model: string;
  calls: number;
  costUsd: number;
}

/** What the user's LLM calls cost since `since`, by step type (or reflection, builder) and model, the most first. */
export async function llmCostSince(prisma: PrismaClient, userId: string, since: Date): Promise<LlmCostRow[]> {
  const rows = await prisma.$queryRaw<{ source: string; model: string | null; calls: string; cost: string }[]>`
    WITH usage AS (
      SELECT s."type" AS source, s."llmUsage" AS u
      FROM "Steps" s JOIN "Runs" r ON r."runId" = s."runId"
      WHERE r."userId" = ${userId}::uuid AND s."startedAt" >= ${since} AND s."llmUsage" ? 'costUsd'
      UNION ALL
      SELECT 'reflection', f."llmUsage" FROM "Reflections" f
      WHERE f."userId" = ${userId}::uuid AND f."startedAt" >= ${since} AND f."llmUsage" ? 'costUsd'
      UNION ALL
      SELECT 'builder', m."llmUsage"
      FROM "BuilderMessages" m JOIN "BuilderChats" c ON c."builderChatId" = m."builderChatId"
      WHERE c."userId" = ${userId}::uuid AND m."dateCreated" >= ${since} AND m."llmUsage" ? 'costUsd'
      UNION ALL
      SELECT 'topic backfill', b."llmUsage" FROM "TopicBackfills" b
      WHERE b."userId" = ${userId}::uuid AND b."dateCreated" >= ${since} AND b."llmUsage" ? 'costUsd'
    )
    SELECT source,
      (SELECT string_agg(value, ' + ') FROM jsonb_array_elements_text(COALESCE(u->'models', '[]'::jsonb))) AS model,
      SUM(COALESCE((u->>'calls')::int, 0))::text AS calls,
      SUM((u->>'costUsd')::numeric)::text AS cost
    FROM usage
    GROUP BY 1, 2
    HAVING SUM((u->>'costUsd')::numeric) > 0
    ORDER BY SUM((u->>'costUsd')::numeric) DESC`;
  return rows.map((row) => ({ source: row.source, model: row.model ?? "unknown", calls: Number(row.calls), costUsd: Number(row.cost) }));
}
