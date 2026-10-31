-- DropIndex
DROP INDEX "BuilderChats_userId_idx";

-- AlterTable
ALTER TABLE "BuilderChats" DROP COLUMN "messages",
ADD COLUMN     "effort" TEXT NOT NULL,
ADD COLUMN     "model" TEXT NOT NULL,
ADD COLUMN     "tokensUsed" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BuilderMessages" (
    "builderMessageId" UUID NOT NULL,
    "builderChatId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "transcript" JSONB,
    "proposal" JSONB,
    "compileErrors" JSONB,
    "error" TEXT,
    "suggestionId" UUID,
    "llmUsage" JSONB,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuilderMessages_pkey" PRIMARY KEY ("builderMessageId")
);

-- CreateIndex
CREATE INDEX "BuilderMessages_builderChatId_dateCreated_idx" ON "BuilderMessages"("builderChatId", "dateCreated");

-- CreateIndex
CREATE INDEX "BuilderChats_userId_pipelineId_idx" ON "BuilderChats"("userId", "pipelineId");

-- AddForeignKey
ALTER TABLE "BuilderMessages" ADD CONSTRAINT "BuilderMessages_builderChatId_fkey" FOREIGN KEY ("builderChatId") REFERENCES "BuilderChats"("builderChatId") ON DELETE CASCADE ON UPDATE CASCADE;
