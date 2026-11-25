-- M62: the connections Storm itself uses (Claude, model servers), set up in Settings instead of .env.
CREATE TYPE "IntegrationKind" AS ENUM ('CLAUDE', 'OPENAI_COMPATIBLE');

CREATE TABLE "Integrations" (
    "integrationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "ciphertext" BYTEA,
    "iv" BYTEA,
    "authTag" BYTEA,
    "wrappedDek" BYTEA,
    "keyVersion" INTEGER,
    "secretHint" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integrations_pkey" PRIMARY KEY ("integrationId")
);

CREATE UNIQUE INDEX "Integrations_userId_name_key" ON "Integrations"("userId", "name");
CREATE INDEX "Integrations_userId_idx" ON "Integrations"("userId");
ALTER TABLE "Integrations" ADD CONSTRAINT "Integrations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- M60's switch and local model give way to the servers' own switches and a default model of any kind. The local models
-- chosen per task named no server (openai:<model>): they go, as the server they meant isn't known here.
ALTER TABLE "UserSettings" DROP COLUMN "localModels";
ALTER TABLE "UserSettings" DROP COLUMN "localModel";
ALTER TABLE "UserSettings" ADD COLUMN "defaultModel" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "embeddingsIntegrationId" UUID;
ALTER TABLE "UserSettings" ADD COLUMN "embeddingsModel" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "builderChatMaxTokens" INTEGER;
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_embeddingsIntegrationId_fkey" FOREIGN KEY ("embeddingsIntegrationId") REFERENCES "Integrations"("integrationId") ON DELETE SET NULL ON UPDATE CASCADE;
DELETE FROM "ModelSettings" WHERE "model" LIKE 'openai:%';
