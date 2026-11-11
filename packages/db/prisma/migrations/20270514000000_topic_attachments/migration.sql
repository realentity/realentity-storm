-- M43-T4: an email's attachments as a topic's sources (docs/design.md §8.1).
-- AlterEnum
ALTER TYPE "TopicSourceKind" ADD VALUE 'ATTACHMENT';

-- AlterTable
ALTER TABLE "TopicSources" ADD COLUMN     "mailbox" TEXT,
ADD COLUMN     "title" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "uid" INTEGER;

