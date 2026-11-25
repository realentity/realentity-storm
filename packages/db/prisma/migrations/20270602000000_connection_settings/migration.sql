-- M63: Telegram and Google's OAuth client join the integrations; the hooks address and the run limits are settings.
-- Nothing is read from .env for them any more (no import: they are entered again in Settings).
ALTER TYPE "IntegrationKind" ADD VALUE 'TELEGRAM';
ALTER TYPE "IntegrationKind" ADD VALUE 'GOOGLE_OAUTH';

ALTER TABLE "Integrations" ADD COLUMN "secretHash" TEXT;

ALTER TABLE "UserSettings"
    ADD COLUMN "hooksPublicUrl" TEXT,
    ADD COLUMN "artifactsRetentionDays" INTEGER,
    ADD COLUMN "takeoverTimeoutMinutes" INTEGER,
    ADD COLUMN "downloadMaxMb" INTEGER;
