-- CreateEnum
CREATE TYPE "TakeoverStatus" AS ENUM ('OPEN', 'TAKEN_OVER', 'CONTINUED', 'ABORTED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Artifacts" ADD COLUMN     "itemIndex" INTEGER,
ADD COLUMN     "size" INTEGER,
ADD COLUMN     "stepKey" TEXT;

-- CreateTable
CREATE TABLE "Takeovers" (
    "takeoverId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "stepKey" TEXT,
    "itemIndex" INTEGER,
    "status" "TakeoverStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "url" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Takeovers_pkey" PRIMARY KEY ("takeoverId")
);

-- CreateIndex
CREATE INDEX "Takeovers_runId_status_idx" ON "Takeovers"("runId", "status");

-- AddForeignKey
ALTER TABLE "Takeovers" ADD CONSTRAINT "Takeovers_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Runs"("runId") ON DELETE CASCADE ON UPDATE CASCADE;
