-- M44-T9: a fact's embedding, made when a draft first needs it (docs/design.md §8.1).
-- AlterTable
ALTER TABLE "TopicFacts" ADD COLUMN     "embedding" vector(1024),
ADD COLUMN     "embeddingModel" TEXT,
ADD COLUMN     "embeddingOf" TEXT;

