-- M43-T1, T3: a topic's sources and the passages indexed from them (docs/design.md §8.1).
-- CreateEnum
CREATE TYPE "TopicSourceKind" AS ENUM ('GITHUB');

-- AlterEnum
ALTER TYPE "TopicFactSource" ADD VALUE 'FILE';

-- CreateTable
CREATE TABLE "TopicSources" (
    "topicSourceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "kind" "TopicSourceKind" NOT NULL,
    "location" TEXT NOT NULL,
    "branch" TEXT,
    "path" TEXT NOT NULL DEFAULT '**',
    "credential" TEXT,
    "cursor" TEXT,
    "readAt" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopicSources_pkey" PRIMARY KEY ("topicSourceId")
);

-- CreateTable
CREATE TABLE "TopicPassages" (
    "topicPassageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "topicSourceId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "refDate" TIMESTAMP(3) NOT NULL,
    "heading" TEXT NOT NULL DEFAULT '',
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" vector(1024),
    "embeddingModel" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopicPassages_pkey" PRIMARY KEY ("topicPassageId")
);

-- CreateIndex
CREATE INDEX "TopicSources_topicId_idx" ON "TopicSources"("topicId");

-- CreateIndex
CREATE INDEX "TopicPassages_topicSourceId_path_idx" ON "TopicPassages"("topicSourceId", "path");

-- CreateIndex
CREATE INDEX "TopicPassages_topicId_idx" ON "TopicPassages"("topicId");

-- AddForeignKey
ALTER TABLE "TopicSources" ADD CONSTRAINT "TopicSources_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicSources" ADD CONSTRAINT "TopicSources_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topics"("topicId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicPassages" ADD CONSTRAINT "TopicPassages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicPassages" ADD CONSTRAINT "TopicPassages_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topics"("topicId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicPassages" ADD CONSTRAINT "TopicPassages_topicSourceId_fkey" FOREIGN KEY ("topicSourceId") REFERENCES "TopicSources"("topicSourceId") ON DELETE CASCADE ON UPDATE CASCADE;

