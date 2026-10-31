-- CreateTable
CREATE TABLE "MailCursors" (
    "mailCursorId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "mailbox" TEXT NOT NULL,
    "uidValidity" BIGINT NOT NULL,
    "lastUid" BIGINT NOT NULL,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailCursors_pkey" PRIMARY KEY ("mailCursorId")
);

-- CreateIndex
CREATE INDEX "MailCursors_userId_idx" ON "MailCursors"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MailCursors_pipelineId_mailbox_key" ON "MailCursors"("pipelineId", "mailbox");

-- AddForeignKey
ALTER TABLE "MailCursors" ADD CONSTRAINT "MailCursors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailCursors" ADD CONSTRAINT "MailCursors_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipelines"("pipelineId") ON DELETE CASCADE ON UPDATE CASCADE;

