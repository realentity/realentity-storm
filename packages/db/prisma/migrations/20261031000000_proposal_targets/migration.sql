-- AlterEnum
ALTER TYPE "ProposalStatus" ADD VALUE 'PREVIEW';

-- AlterTable
ALTER TABLE "Proposals" ADD COLUMN     "approvedNewTargets" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "targets" JSONB;

