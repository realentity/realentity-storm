-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_FOR_USER', 'DONE', 'FAILED', 'ABORTED');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'EXECUTING', 'WAITING_FOR_USER', 'DONE', 'FAILED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DecisionKind" AS ENUM ('APPROVED', 'EDITED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('SUGGESTED', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('PASSWORD', 'TOTP_SEED', 'API_KEY', 'OAUTH_TOKEN', 'STORAGE_STATE');

-- CreateEnum
CREATE TYPE "JobPostingStatus" AS ENUM ('NEW', 'SHORTLISTED', 'SKIPPED', 'APPLIED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PREPARED', 'SUBMITTED', 'RESPONDED', 'REJECTED', 'INTERVIEW');

-- CreateTable
CREATE TABLE "Users" (
    "userId" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "displayName" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Users_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "UserSessions" (
    "userSessionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "ipAddress" VARCHAR(64),
    "userAgent" VARCHAR(500),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSessions_pkey" PRIMARY KEY ("userSessionId")
);

-- CreateTable
CREATE TABLE "Pipelines" (
    "pipelineId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "currentVersionId" UUID,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pipelines_pkey" PRIMARY KEY ("pipelineId")
);

-- CreateTable
CREATE TABLE "PipelineVersions" (
    "pipelineVersionId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "policy" JSONB NOT NULL,
    "changeSummary" TEXT,
    "builderChatId" UUID,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineVersions_pkey" PRIMARY KEY ("pipelineVersionId")
);

-- CreateTable
CREATE TABLE "BuilderChats" (
    "builderChatId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "pipelineId" UUID,
    "messages" JSONB NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuilderChats_pkey" PRIMARY KEY ("builderChatId")
);

-- CreateTable
CREATE TABLE "SiteRecipes" (
    "siteRecipeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "site" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "steps" JSONB NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteRecipes_pkey" PRIMARY KEY ("siteRecipeId")
);

-- CreateTable
CREATE TABLE "Runs" (
    "runId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "pipelineVersionId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "headed" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" TEXT,

    CONSTRAINT "Runs_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "Steps" (
    "stepId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "stepKey" TEXT NOT NULL,
    "itemIndex" INTEGER,
    "type" TEXT NOT NULL,
    "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB,
    "output" JSONB,
    "llmUsage" JSONB,
    "screenshot" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Steps_pkey" PRIMARY KEY ("stepId")
);

-- CreateTable
CREATE TABLE "Proposals" (
    "proposalId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "stepId" UUID NOT NULL,
    "stepKey" TEXT NOT NULL,
    "itemIndex" INTEGER,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "target" TEXT NOT NULL,
    "originalPayload" JSONB NOT NULL,
    "finalPayload" JSONB,
    "payloadHash" VARCHAR(64),
    "reasoning" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Proposals_pkey" PRIMARY KEY ("proposalId")
);

-- CreateTable
CREATE TABLE "Decisions" (
    "decisionId" UUID NOT NULL,
    "proposalId" UUID NOT NULL,
    "kind" "DecisionKind" NOT NULL,
    "diff" JSONB,
    "reason" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decisions_pkey" PRIMARY KEY ("decisionId")
);

-- CreateTable
CREATE TABLE "Artifacts" (
    "artifactId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "runId" UUID,
    "kind" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mime" TEXT,
    "sha256" VARCHAR(64),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifacts_pkey" PRIMARY KEY ("artifactId")
);

-- CreateTable
CREATE TABLE "Rules" (
    "ruleId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stepType" TEXT,
    "pipelineId" UUID,
    "text" TEXT NOT NULL,
    "status" "RuleStatus" NOT NULL DEFAULT 'SUGGESTED',
    "source" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rules_pkey" PRIMARY KEY ("ruleId")
);

-- CreateTable
CREATE TABLE "Examples" (
    "exampleId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stepType" TEXT NOT NULL,
    "pipelineId" UUID,
    "context" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "embedding" vector(1024),
    "proposalId" UUID,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Examples_pkey" PRIMARY KEY ("exampleId")
);

-- CreateTable
CREATE TABLE "Credentials" (
    "credentialId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "allowedHosts" TEXT[],
    "username" TEXT,
    "kind" "CredentialKind" NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "lastUsedAt" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credentials_pkey" PRIMARY KEY ("credentialId")
);

-- CreateTable
CREATE TABLE "ModelSettings" (
    "userId" UUID NOT NULL,
    "taskKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effort" TEXT,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelSettings_pkey" PRIMARY KEY ("userId","taskKey")
);

-- CreateTable
CREATE TABLE "JobPostings" (
    "jobPostingId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT,
    "location" TEXT,
    "description" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "scoreReason" TEXT,
    "status" "JobPostingStatus" NOT NULL DEFAULT 'NEW',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobPostings_pkey" PRIMARY KEY ("jobPostingId")
);

-- CreateTable
CREATE TABLE "Applications" (
    "applicationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "jobPostingId" UUID NOT NULL,
    "proposalId" UUID,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PREPARED',
    "cvArtifactId" UUID,
    "submittedAt" TIMESTAMP(3),
    "notes" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Applications_pkey" PRIMARY KEY ("applicationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Users_email_key" ON "Users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserSessions_tokenHash_key" ON "UserSessions"("tokenHash");

-- CreateIndex
CREATE INDEX "UserSessions_userId_idx" ON "UserSessions"("userId");

-- CreateIndex
CREATE INDEX "Pipelines_userId_idx" ON "Pipelines"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineVersions_pipelineId_version_key" ON "PipelineVersions"("pipelineId", "version");

-- CreateIndex
CREATE INDEX "BuilderChats_userId_idx" ON "BuilderChats"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteRecipes_userId_name_version_key" ON "SiteRecipes"("userId", "name", "version");

-- CreateIndex
CREATE INDEX "Runs_userId_status_idx" ON "Runs"("userId", "status");

-- CreateIndex
CREATE INDEX "Steps_runId_idx" ON "Steps"("runId");

-- CreateIndex
CREATE INDEX "Proposals_userId_status_idx" ON "Proposals"("userId", "status");

-- CreateIndex
CREATE INDEX "Proposals_runId_idx" ON "Proposals"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "Decisions_proposalId_key" ON "Decisions"("proposalId");

-- CreateIndex
CREATE INDEX "Artifacts_userId_idx" ON "Artifacts"("userId");

-- CreateIndex
CREATE INDEX "Artifacts_runId_idx" ON "Artifacts"("runId");

-- CreateIndex
CREATE INDEX "Rules_userId_status_idx" ON "Rules"("userId", "status");

-- CreateIndex
CREATE INDEX "Examples_userId_stepType_idx" ON "Examples"("userId", "stepType");

-- CreateIndex
CREATE UNIQUE INDEX "Credentials_userId_name_key" ON "Credentials"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "JobPostings_userId_url_key" ON "JobPostings"("userId", "url");

-- CreateIndex
CREATE INDEX "Applications_userId_idx" ON "Applications"("userId");

-- AddForeignKey
ALTER TABLE "UserSessions" ADD CONSTRAINT "UserSessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipelines" ADD CONSTRAINT "Pipelines_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineVersions" ADD CONSTRAINT "PipelineVersions_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipelines"("pipelineId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuilderChats" ADD CONSTRAINT "BuilderChats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuilderChats" ADD CONSTRAINT "BuilderChats_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipelines"("pipelineId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteRecipes" ADD CONSTRAINT "SiteRecipes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Runs" ADD CONSTRAINT "Runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Runs" ADD CONSTRAINT "Runs_pipelineVersionId_fkey" FOREIGN KEY ("pipelineVersionId") REFERENCES "PipelineVersions"("pipelineVersionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Steps" ADD CONSTRAINT "Steps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Runs"("runId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposals" ADD CONSTRAINT "Proposals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposals" ADD CONSTRAINT "Proposals_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Runs"("runId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposals" ADD CONSTRAINT "Proposals_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "Steps"("stepId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decisions" ADD CONSTRAINT "Decisions_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposals"("proposalId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifacts" ADD CONSTRAINT "Artifacts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifacts" ADD CONSTRAINT "Artifacts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Runs"("runId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rules" ADD CONSTRAINT "Rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Examples" ADD CONSTRAINT "Examples_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credentials" ADD CONSTRAINT "Credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelSettings" ADD CONSTRAINT "ModelSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPostings" ADD CONSTRAINT "JobPostings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Applications" ADD CONSTRAINT "Applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Applications" ADD CONSTRAINT "Applications_jobPostingId_fkey" FOREIGN KEY ("jobPostingId") REFERENCES "JobPostings"("jobPostingId") ON DELETE CASCADE ON UPDATE CASCADE;

