-- M29: data.alert remembers what is past its line, per pipeline, step and key.
CREATE TABLE "AlertStates" (
    "alertStateId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "stepKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertStates_pkey" PRIMARY KEY ("alertStateId")
);

-- CreateIndex
CREATE INDEX "AlertStates_userId_idx" ON "AlertStates"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertStates_pipelineId_stepKey_key_key" ON "AlertStates"("pipelineId", "stepKey", "key");

-- AddForeignKey
ALTER TABLE "AlertStates" ADD CONSTRAINT "AlertStates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertStates" ADD CONSTRAINT "AlertStates_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipelines"("pipelineId") ON DELETE CASCADE ON UPDATE CASCADE;
