-- M44: what Storm suggests for topics from the user's decisions and edits (docs/design.md §8.1).
-- CreateEnum
CREATE TYPE "TopicSuggestionKind" AS ENUM ('DIRECTION', 'TOPIC', 'FACT');

-- CreateEnum
CREATE TYPE "TopicSuggestionStatus" AS ENUM ('OPEN', 'ACCEPTED', 'DISMISSED');

-- CreateTable
CREATE TABLE "TopicSuggestions" (
    "topicSuggestionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "topicId" UUID,
    "kind" "TopicSuggestionKind" NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "TopicSuggestionStatus" NOT NULL DEFAULT 'OPEN',
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "TopicSuggestions_pkey" PRIMARY KEY ("topicSuggestionId")
);

-- CreateIndex
CREATE INDEX "TopicSuggestions_userId_status_idx" ON "TopicSuggestions"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TopicSuggestions_userId_key_key" ON "TopicSuggestions"("userId", "key");

-- AddForeignKey
ALTER TABLE "TopicSuggestions" ADD CONSTRAINT "TopicSuggestions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicSuggestions" ADD CONSTRAINT "TopicSuggestions_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topics"("topicId") ON DELETE CASCADE ON UPDATE CASCADE;

