-- M41-T3: an email's topics (docs/design.md §8.1).
-- CreateEnum
CREATE TYPE "TopicLinkStatus" AS ENUM ('LINKED', 'SUGGESTED', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TopicLinkVia" AS ENUM ('DIRECTION', 'THREAD', 'LLM', 'USER');

-- CreateTable
CREATE TABLE "TopicLinks" (
    "topicLinkId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "messageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "status" "TopicLinkStatus" NOT NULL,
    "via" "TopicLinkVia" NOT NULL,
    "evidence" TEXT NOT NULL,
    "runId" UUID,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopicLinks_pkey" PRIMARY KEY ("topicLinkId")
);

-- CreateIndex
CREATE INDEX "TopicLinks_userId_status_idx" ON "TopicLinks"("userId", "status");

-- CreateIndex
CREATE INDEX "TopicLinks_userId_threadId_idx" ON "TopicLinks"("userId", "threadId");

-- CreateIndex
CREATE INDEX "TopicLinks_userId_messageId_idx" ON "TopicLinks"("userId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "TopicLinks_topicId_messageId_key" ON "TopicLinks"("topicId", "messageId");

-- AddForeignKey
ALTER TABLE "TopicLinks" ADD CONSTRAINT "TopicLinks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicLinks" ADD CONSTRAINT "TopicLinks_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topics"("topicId") ON DELETE CASCADE ON UPDATE CASCADE;

