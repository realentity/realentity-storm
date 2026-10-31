-- AlterTable
ALTER TABLE "Pipelines" ADD COLUMN     "essential" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Runs" ADD COLUMN     "resumeAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "UserSettings" (
    "userId" UUID NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pausedAt" TIMESTAMP(3),
    "rateLimits" JSONB NOT NULL DEFAULT '{}',
    "monthlyBudgetUsd" DECIMAL(10,2),
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

