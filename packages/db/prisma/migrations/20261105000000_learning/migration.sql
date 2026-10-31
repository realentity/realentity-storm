-- CreateEnum
CREATE TYPE "ReflectionStatus" AS ENUM ('SUBMITTED', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('OPEN', 'DONE', 'DISMISSED');

-- AlterTable
ALTER TABLE "Examples" ADD COLUMN     "embeddingModel" TEXT;

-- AlterTable
ALTER TABLE "Rules" ADD COLUMN     "rationale" TEXT;

-- CreateTable
CREATE TABLE "Reflections" (
    "reflectionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "ReflectionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "batchId" TEXT,
    "since" TIMESTAMP(3) NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "decisions" INTEGER NOT NULL,
    "llmUsage" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Reflections_pkey" PRIMARY KEY ("reflectionId")
);

-- CreateTable
CREATE TABLE "PipelineSuggestions" (
    "suggestionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "rationale" TEXT,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'OPEN',
    "source" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineSuggestions_pkey" PRIMARY KEY ("suggestionId")
);

-- CreateIndex
CREATE INDEX "Reflections_userId_startedAt_idx" ON "Reflections"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "PipelineSuggestions_userId_status_idx" ON "PipelineSuggestions"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Examples_proposalId_stepType_key" ON "Examples"("proposalId", "stepType");

-- AddForeignKey
ALTER TABLE "Reflections" ADD CONSTRAINT "Reflections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineSuggestions" ADD CONSTRAINT "PipelineSuggestions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineSuggestions" ADD CONSTRAINT "PipelineSuggestions_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipelines"("pipelineId") ON DELETE CASCADE ON UPDATE CASCADE;

