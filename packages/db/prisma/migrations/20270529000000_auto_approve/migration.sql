-- M54: a pipeline acts without asking at its gates when the user starts it, for the version it was turned on for.
ALTER TABLE "Pipelines" ADD COLUMN "autoApproveVersionId" UUID;
