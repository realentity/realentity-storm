-- M50-T7: the user's email accounts (its password sealed), and which one a cursor, a topic's attachment and a slot use.
-- AlterTable
ALTER TABLE "MailCursors" ADD COLUMN     "emailAccountId" UUID;

-- AlterTable
ALTER TABLE "TopicSources" ADD COLUMN     "emailAccountId" UUID;

-- AlterTable
ALTER TABLE "Bindings" ADD COLUMN     "emailAccountId" UUID;

-- CreateTable
CREATE TABLE "EmailAccounts" (
    "emailAccountId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL,
    "tls" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "lastUsedAt" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailAccounts_pkey" PRIMARY KEY ("emailAccountId")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailAccounts_userId_address_key" ON "EmailAccounts"("userId", "address");

-- AddForeignKey
ALTER TABLE "Bindings" ADD CONSTRAINT "Bindings_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccounts"("emailAccountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAccounts" ADD CONSTRAINT "EmailAccounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

