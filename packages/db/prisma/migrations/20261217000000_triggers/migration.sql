-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "telegramApprovals" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Runs" ADD COLUMN     "chainDepth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "triggerData" JSONB,
ADD COLUMN     "triggeredByRunId" UUID;

-- AlterTable
ALTER TABLE "Proposals" ADD COLUMN     "notifiedAt" TIMESTAMP(3),
ADD COLUMN     "telegramMessageId" INTEGER;

-- CreateTable
CREATE TABLE "Webhooks" (
    "webhookId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "secretHash" VARCHAR(64) NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "lastCalledAt" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Webhooks_pkey" PRIMARY KEY ("webhookId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Webhooks_pipelineId_key" ON "Webhooks"("pipelineId");

-- CreateIndex
CREATE INDEX "Webhooks_userId_idx" ON "Webhooks"("userId");

-- AddForeignKey
ALTER TABLE "Webhooks" ADD CONSTRAINT "Webhooks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhooks" ADD CONSTRAINT "Webhooks_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipelines"("pipelineId") ON DELETE CASCADE ON UPDATE CASCADE;

