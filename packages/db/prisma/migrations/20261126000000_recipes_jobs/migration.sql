-- AlterTable
ALTER TABLE "SiteRecipes" ADD COLUMN     "brokenAt" TIMESTAMP(3),
ADD COLUMN     "brokenReason" TEXT,
ADD COLUMN     "taughtInRunId" UUID;

-- AlterTable (existing postings get the migration time as their last update)
ALTER TABLE "JobPostings" ADD COLUMN     "dateUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "description" SET DEFAULT '';
ALTER TABLE "JobPostings" ALTER COLUMN "dateUpdated" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BuilderChats" ADD COLUMN     "system" TEXT;

-- CreateIndex
CREATE INDEX "JobPostings_userId_status_idx" ON "JobPostings"("userId", "status");
