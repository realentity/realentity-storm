-- M50: a pipeline's or an App install's slots filled by a credential (by id) or a text (docs/capabilities.md, needs).
-- CreateTable
CREATE TABLE "Bindings" (
    "bindingId" UUID NOT NULL,
    "pipelineId" UUID,
    "appId" UUID,
    "slot" TEXT NOT NULL,
    "credentialId" UUID,
    "text" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bindings_pkey" PRIMARY KEY ("bindingId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Bindings_pipelineId_slot_key" ON "Bindings"("pipelineId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "Bindings_appId_slot_key" ON "Bindings"("appId", "slot");

-- AddForeignKey
ALTER TABLE "Bindings" ADD CONSTRAINT "Bindings_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipelines"("pipelineId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bindings" ADD CONSTRAINT "Bindings_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Apps"("appId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bindings" ADD CONSTRAINT "Bindings_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credentials"("credentialId") ON DELETE CASCADE ON UPDATE CASCADE;


-- A binding is a pipeline's or an App install's, never both or neither.
ALTER TABLE "Bindings" ADD CONSTRAINT "Bindings_one_owner" CHECK (("pipelineId" IS NULL) <> ("appId" IS NULL));
