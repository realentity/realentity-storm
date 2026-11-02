-- CreateEnum
CREATE TYPE "FactSource" AS ENUM ('FORM', 'ASKED', 'ME');

-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('OPEN', 'ANSWERED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Facts" (
    "factId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "source" "FactSource" NOT NULL,
    "site" TEXT,
    "proposalId" UUID,
    "runId" UUID,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Facts_pkey" PRIMARY KEY ("factId")
);

-- CreateTable
CREATE TABLE "Questions" (
    "questionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "stepKey" TEXT NOT NULL,
    "itemIndex" INTEGER,
    "question" TEXT NOT NULL,
    "options" TEXT[],
    "site" TEXT,
    "status" "QuestionStatus" NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "telegramMessageId" INTEGER,
    "factId" UUID,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "Questions_pkey" PRIMARY KEY ("questionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Facts_userId_key_key" ON "Facts"("userId", "key");

-- CreateIndex
CREATE INDEX "Questions_userId_status_idx" ON "Questions"("userId", "status");

-- CreateIndex
CREATE INDEX "Questions_telegramMessageId_idx" ON "Questions"("telegramMessageId");

-- AddForeignKey
ALTER TABLE "Facts" ADD CONSTRAINT "Facts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Questions" ADD CONSTRAINT "Questions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Questions" ADD CONSTRAINT "Questions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Runs"("runId") ON DELETE CASCADE ON UPDATE CASCADE;

