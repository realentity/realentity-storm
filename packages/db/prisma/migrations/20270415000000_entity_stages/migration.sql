-- M32: an entity's stage and when it first reached each state.
ALTER TABLE "DataEntities" ADD COLUMN "stage" TEXT;
ALTER TABLE "DataEntities" ADD COLUMN "stageDates" JSONB NOT NULL DEFAULT '{}';
