-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "profile" TEXT;

-- AlterTable
ALTER TABLE "Applications" ADD COLUMN     "runId" UUID;

-- CreateTable
CREATE TABLE "Documents" (
    "documentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "path" TEXT NOT NULL,
    "replacedAt" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Documents_pkey" PRIMARY KEY ("documentId")
);

-- CreateIndex
CREATE INDEX "Documents_userId_name_idx" ON "Documents"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Applications_jobPostingId_key" ON "Applications"("jobPostingId");

-- AddForeignKey
ALTER TABLE "Documents" ADD CONSTRAINT "Documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

