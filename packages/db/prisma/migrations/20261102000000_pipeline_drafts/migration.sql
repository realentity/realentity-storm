-- AlterTable
ALTER TABLE "PipelineVersions" ADD COLUMN     "savedAt" TIMESTAMP(3);

-- Versions saved before drafts existed
UPDATE "PipelineVersions" SET "savedAt" = "dateCreated";
