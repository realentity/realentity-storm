-- M50-T8: several Google accounts per user, one the default; a slot and a Drive source can name one. The single
-- connection goes: its refresh token was sealed to the user's id, so it is connected again in Settings (M50-T10).
-- DropForeignKey
ALTER TABLE "GoogleConnections" DROP CONSTRAINT "GoogleConnections_userId_fkey";

-- AlterTable
ALTER TABLE "TopicSources" ADD COLUMN     "googleAccountId" UUID;

-- AlterTable
ALTER TABLE "Bindings" ADD COLUMN     "googleAccountId" UUID;

-- DropTable
DROP TABLE "GoogleConnections";

-- CreateTable
CREATE TABLE "GoogleAccounts" (
    "googleAccountId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "scopes" TEXT[],
    "status" "GoogleConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "lastWorkedAt" TIMESTAMP(3),
    "brokenAt" TIMESTAMP(3),
    "brokenReason" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAccounts_pkey" PRIMARY KEY ("googleAccountId")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAccounts_userId_email_key" ON "GoogleAccounts"("userId", "email");

-- AddForeignKey
ALTER TABLE "GoogleAccounts" ADD CONSTRAINT "GoogleAccounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicSources" ADD CONSTRAINT "TopicSources_googleAccountId_fkey" FOREIGN KEY ("googleAccountId") REFERENCES "GoogleAccounts"("googleAccountId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bindings" ADD CONSTRAINT "Bindings_googleAccountId_fkey" FOREIGN KEY ("googleAccountId") REFERENCES "GoogleAccounts"("googleAccountId") ON DELETE CASCADE ON UPDATE CASCADE;

