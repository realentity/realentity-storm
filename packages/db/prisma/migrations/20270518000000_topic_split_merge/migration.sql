-- M44-T4: a topic split or merged, as one change that can be undone (docs/design.md §8.1).
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TopicChangeKind" ADD VALUE 'SPLIT';
ALTER TYPE "TopicChangeKind" ADD VALUE 'MERGE';

-- AlterTable
ALTER TABLE "TopicChanges" ADD COLUMN     "moves" JSONB NOT NULL DEFAULT '[]';

