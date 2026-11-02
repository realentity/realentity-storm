-- CreateTable
CREATE TABLE "FollowUps" (
    "followUpId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "messageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "runId" UUID,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowUps_pkey" PRIMARY KEY ("followUpId")
);

-- CreateIndex
CREATE UNIQUE INDEX "FollowUps_userId_messageId_key" ON "FollowUps"("userId", "messageId");

-- AddForeignKey
ALTER TABLE "FollowUps" ADD CONSTRAINT "FollowUps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
