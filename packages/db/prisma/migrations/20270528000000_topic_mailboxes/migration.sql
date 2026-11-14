-- M50-T16: a topic's mailbox is a source (MAILBOX: one of the user's email accounts), and a pipeline reading several
-- accounts keeps a cursor for each.
-- AlterEnum
ALTER TYPE "TopicSourceKind" ADD VALUE 'MAILBOX';

-- DropIndex
DROP INDEX "MailCursors_pipelineId_mailbox_key";

-- CreateIndex
CREATE UNIQUE INDEX "MailCursors_pipelineId_mailbox_emailAccountId_key" ON "MailCursors"("pipelineId", "mailbox", "emailAccountId");

-- An attachment's account that is gone (removed before this): the default one.
UPDATE "TopicSources" SET "emailAccountId" = NULL
WHERE "emailAccountId" IS NOT NULL AND "emailAccountId" NOT IN (SELECT "emailAccountId" FROM "EmailAccounts");

-- AddForeignKey
ALTER TABLE "TopicSources" ADD CONSTRAINT "TopicSources_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccounts"("emailAccountId") ON DELETE SET NULL ON UPDATE CASCADE;
