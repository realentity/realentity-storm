-- M44-T2: triaged emails that belonged to no topic, for suggested topics (docs/design.md §8.1).
-- AlterTable
ALTER TABLE "Reflections" ADD COLUMN     "unlinked" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "UnlinkedEmails" (
    "unlinkedEmailId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "messageId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnlinkedEmails_pkey" PRIMARY KEY ("unlinkedEmailId")
);

-- CreateIndex
CREATE INDEX "UnlinkedEmails_userId_date_idx" ON "UnlinkedEmails"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "UnlinkedEmails_userId_messageId_key" ON "UnlinkedEmails"("userId", "messageId");

-- AddForeignKey
ALTER TABLE "UnlinkedEmails" ADD CONSTRAINT "UnlinkedEmails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

