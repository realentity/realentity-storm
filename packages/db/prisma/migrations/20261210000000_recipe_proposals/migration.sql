-- AlterTable
ALTER TABLE "SiteRecipes" ADD COLUMN     "proposed" JSONB,
ADD COLUMN     "proposedAt" TIMESTAMP(3),
ADD COLUMN     "proposedInRunId" UUID;

