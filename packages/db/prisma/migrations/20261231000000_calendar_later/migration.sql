-- CreateEnum
CREATE TYPE "GoogleConnectionStatus" AS ENUM ('CONNECTED', 'NEEDS_RECONNECT');

-- CreateEnum
CREATE TYPE "ScheduledStartStatus" AS ENUM ('PENDING', 'STARTED', 'CANCELLED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Takeovers" ADD COLUMN     "waitsFor" TEXT;

-- CreateTable
CREATE TABLE "GoogleConnections" (
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "scopes" TEXT[],
    "status" "GoogleConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "lastWorkedAt" TIMESTAMP(3),
    "brokenAt" TIMESTAMP(3),
    "brokenReason" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleConnections_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ScheduledStarts" (
    "scheduledStartId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "key" TEXT,
    "data" JSONB NOT NULL,
    "cancelOn" JSONB,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "status" "ScheduledStartStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "scheduledByRunId" UUID,
    "runId" UUID,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledStarts_pkey" PRIMARY KEY ("scheduledStartId")
);

-- CreateIndex
CREATE INDEX "ScheduledStarts_userId_status_idx" ON "ScheduledStarts"("userId", "status");

-- CreateIndex
CREATE INDEX "ScheduledStarts_userId_key_idx" ON "ScheduledStarts"("userId", "key");

-- AddForeignKey
ALTER TABLE "GoogleConnections" ADD CONSTRAINT "GoogleConnections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledStarts" ADD CONSTRAINT "ScheduledStarts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledStarts" ADD CONSTRAINT "ScheduledStarts_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipelines"("pipelineId") ON DELETE CASCADE ON UPDATE CASCADE;

