-- M39-T1: a saved pipeline's name is unique per user, as an App's: a name means one pipeline. The duplicates there are
-- get " (2)", " (3)" (the oldest keeps the name), the first such name not taken; each is reported as a NOTICE.
-- Drafts that were never saved (a dry run of a new pipeline) may share a name until they are saved.
DO $$
DECLARE
  duplicate RECORD;
  candidate TEXT;
  n INT;
BEGIN
  FOR duplicate IN
    SELECT "pipelineId", "userId", name
    FROM (
      SELECT "pipelineId", "userId", name,
             ROW_NUMBER() OVER (PARTITION BY "userId", name ORDER BY "dateCreated", "pipelineId") AS rank
      FROM "Pipelines"
      WHERE "currentVersionId" IS NOT NULL
    ) ranked
    WHERE rank > 1
    ORDER BY "userId", name, rank
  LOOP
    n := 2;
    LOOP
      candidate := duplicate.name || ' (' || n || ')';
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "Pipelines"
        WHERE "userId" = duplicate."userId" AND name = candidate AND "currentVersionId" IS NOT NULL
      );
      n := n + 1;
    END LOOP;
    UPDATE "Pipelines" SET name = candidate WHERE "pipelineId" = duplicate."pipelineId";
    RAISE NOTICE 'M39: pipeline % renamed from "%" to "%": another pipeline had its name', duplicate."pipelineId", duplicate.name, candidate;
  END LOOP;
END $$;

-- Not in schema.prisma: Prisma has no partial unique index. The api checks first and says which name is taken.
CREATE UNIQUE INDEX "Pipelines_userId_name_saved_key" ON "Pipelines" ("userId", name) WHERE "currentVersionId" IS NOT NULL;
