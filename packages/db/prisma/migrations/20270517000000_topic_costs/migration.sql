-- M44-T5: what a topic's upkeep cost, by day (docs/design.md §8.1).
-- CreateTable
CREATE TABLE "TopicCosts" (
    "topicCostId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "TopicCosts_pkey" PRIMARY KEY ("topicCostId")
);

-- CreateIndex
CREATE INDEX "TopicCosts_userId_day_idx" ON "TopicCosts"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "TopicCosts_topicId_day_source_key" ON "TopicCosts"("topicId", "day", "source");

-- AddForeignKey
ALTER TABLE "TopicCosts" ADD CONSTRAINT "TopicCosts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicCosts" ADD CONSTRAINT "TopicCosts_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topics"("topicId") ON DELETE CASCADE ON UPDATE CASCADE;

