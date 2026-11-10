-- M41-T2: topics and their directions (docs/design.md §8.1).
-- CreateEnum
CREATE TYPE "TopicStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TopicDirectionKind" AS ENUM ('WORD', 'DOMAIN', 'PERSON', 'TEXT');

-- CreateTable
CREATE TABLE "Topics" (
    "topicId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "TopicStatus" NOT NULL DEFAULT 'ACTIVE',
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Topics_pkey" PRIMARY KEY ("topicId")
);

-- CreateTable
CREATE TABLE "TopicDirections" (
    "topicDirectionId" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "kind" "TopicDirectionKind" NOT NULL,
    "value" TEXT NOT NULL,
    "about" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopicDirections_pkey" PRIMARY KEY ("topicDirectionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Topics_userId_name_key" ON "Topics"("userId", "name");

-- CreateIndex
CREATE INDEX "TopicDirections_topicId_idx" ON "TopicDirections"("topicId");

-- AddForeignKey
ALTER TABLE "Topics" ADD CONSTRAINT "Topics_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicDirections" ADD CONSTRAINT "TopicDirections_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topics"("topicId") ON DELETE CASCADE ON UPDATE CASCADE;

