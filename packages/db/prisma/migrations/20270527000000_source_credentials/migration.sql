-- M50-T9: a topic's GitHub source names its token by the credential's id, not its name; the name it had is looked up.
-- AlterTable
ALTER TABLE "TopicSources" ADD COLUMN     "credentialId" UUID;

UPDATE "TopicSources" AS s SET "credentialId" = c."credentialId"
FROM "Credentials" AS c
WHERE c."userId" = s."userId" AND c."name" = s."credential";

ALTER TABLE "TopicSources" DROP COLUMN "credential";

-- AddForeignKey
ALTER TABLE "TopicSources" ADD CONSTRAINT "TopicSources_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credentials"("credentialId") ON DELETE SET NULL ON UPDATE CASCADE;
