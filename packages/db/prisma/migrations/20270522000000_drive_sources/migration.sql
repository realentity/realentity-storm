-- M43-T2: a Google Drive folder as a topic's source; a passage's Drive file id (docs/design.md §8.1).
-- AlterEnum
ALTER TYPE "TopicSourceKind" ADD VALUE 'DRIVE';

-- AlterTable
ALTER TABLE "TopicPassages" ADD COLUMN     "documentId" TEXT;

-- CreateIndex
CREATE INDEX "TopicPassages_topicSourceId_documentId_idx" ON "TopicPassages"("topicSourceId", "documentId");

