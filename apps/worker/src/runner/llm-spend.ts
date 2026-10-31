import { type PrismaClient } from "@ai-me/db";

/**
 * What the user's LLM calls cost since `since`: steps (Step.llmUsage), reflections (Reflection.llmUsage) and builder
 * chats (BuilderMessage.llmUsage).
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
      ), 0)
    )::text AS spent`;
  return Number(rows[0]?.spent ?? 0);
}
