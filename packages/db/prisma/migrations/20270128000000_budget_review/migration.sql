-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "budgetReachedAt" TIMESTAMP(3),
ADD COLUMN     "budgetWarnedAt" TIMESTAMP(3),
ADD COLUMN     "weeklyReview" BOOLEAN NOT NULL DEFAULT true;
