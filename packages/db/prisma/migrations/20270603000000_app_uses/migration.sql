-- M66: which of the user's Apps fills a use of another App's type (`uses:` in an App's YAML), by id.
CREATE TABLE "AppUses" (
    "appUseId" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sourceAppId" UUID NOT NULL,
    "sourceType" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppUses_pkey" PRIMARY KEY ("appUseId")
);

CREATE UNIQUE INDEX "AppUses_appId_name_key" ON "AppUses"("appId", "name");
CREATE INDEX "AppUses_sourceAppId_idx" ON "AppUses"("sourceAppId");

ALTER TABLE "AppUses" ADD CONSTRAINT "AppUses_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Apps"("appId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppUses" ADD CONSTRAINT "AppUses_sourceAppId_fkey" FOREIGN KEY ("sourceAppId") REFERENCES "Apps"("appId") ON DELETE CASCADE ON UPDATE CASCADE;
