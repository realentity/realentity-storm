-- M43-T5: reading a topic's history for facts (docs/design.md §8.1).
-- CreateEnum
CREATE TYPE "TopicBackfillStatus" AS ENUM ('ESTIMATING', 'ESTIMATED', 'SCREENING', 'PROPOSING', 'REVIEW', 'DONE', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "TopicBackfills" (
    "topicBackfillId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "months" INTEGER NOT NULL,
    "documents" BOOLEAN NOT NULL DEFAULT true,
    "status" "TopicBackfillStatus" NOT NULL DEFAULT 'ESTIMATING',
    "emails" JSONB NOT NULL DEFAULT '[]',
    "files" JSONB NOT NULL DEFAULT '[]',
    "estimateUsd" DOUBLE PRECISION,
    "worth" JSONB,
    "batchId" TEXT,
    "proposals" JSONB NOT NULL DEFAULT '[]',
    "applied" INTEGER NOT NULL DEFAULT 0,
    "llmUsage" JSONB,
    "error" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "TopicBackfills_pkey" PRIMARY KEY ("topicBackfillId")
);

-- CreateIndex
CREATE INDEX "TopicBackfills_topicId_dateCreated_idx" ON "TopicBackfills"("topicId", "dateCreated");

-- CreateIndex
CREATE INDEX "TopicBackfills_userId_status_idx" ON "TopicBackfills"("userId", "status");

-- AddForeignKey
ALTER TABLE "TopicBackfills" ADD CONSTRAINT "TopicBackfills_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicBackfills" ADD CONSTRAINT "TopicBackfills_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topics"("topicId") ON DELETE CASCADE ON UPDATE CASCADE;

