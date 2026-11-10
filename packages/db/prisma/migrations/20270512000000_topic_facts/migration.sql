-- M42-T1: a topic's facts and their changes (docs/design.md §8.1).
-- CreateEnum
CREATE TYPE "TopicFactStatus" AS ENUM ('CURRENT', 'SUPERSEDED', 'DISPUTED', 'WRONG');

-- CreateEnum
CREATE TYPE "TopicFactSource" AS ENUM ('EMAIL', 'USER');

-- CreateEnum
CREATE TYPE "TopicChangeKind" AS ENUM ('ADD', 'EDIT', 'NO_LONGER_TRUE', 'WRONG', 'MOVE', 'SETTLE', 'APPLY');

-- CreateTable
CREATE TABLE "TopicFacts" (
    "topicFactId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "about" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "source" "TopicFactSource" NOT NULL,
    "sourceId" TEXT,
    "sourceLabel" TEXT NOT NULL,
    "sourceDate" TIMESTAMP(3) NOT NULL,
    "quote" TEXT NOT NULL DEFAULT '',
    "status" "TopicFactStatus" NOT NULL DEFAULT 'CURRENT',
    "supersededById" UUID,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "runId" UUID,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopicFacts_pkey" PRIMARY KEY ("topicFactId")
);

-- CreateTable
CREATE TABLE "TopicChanges" (
    "topicChangeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "otherTopicId" UUID,
    "kind" "TopicChangeKind" NOT NULL,
    "summary" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "links" JSONB NOT NULL DEFAULT '[]',
    "runId" UUID,
    "undoneAt" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopicChanges_pkey" PRIMARY KEY ("topicChangeId")
);

-- CreateIndex
CREATE INDEX "TopicFacts_topicId_status_idx" ON "TopicFacts"("topicId", "status");

-- CreateIndex
CREATE INDEX "TopicFacts_userId_sourceId_idx" ON "TopicFacts"("userId", "sourceId");

-- CreateIndex
CREATE INDEX "TopicChanges_topicId_dateCreated_idx" ON "TopicChanges"("topicId", "dateCreated");

-- CreateIndex
CREATE INDEX "TopicChanges_userId_otherTopicId_idx" ON "TopicChanges"("userId", "otherTopicId");

-- AddForeignKey
ALTER TABLE "TopicFacts" ADD CONSTRAINT "TopicFacts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicFacts" ADD CONSTRAINT "TopicFacts_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topics"("topicId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicFacts" ADD CONSTRAINT "TopicFacts_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "TopicFacts"("topicFactId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicChanges" ADD CONSTRAINT "TopicChanges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicChanges" ADD CONSTRAINT "TopicChanges_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topics"("topicId") ON DELETE CASCADE ON UPDATE CASCADE;

