-- M30: Apps, their versions, and the entities of their types.
CREATE TABLE "Apps" (
    "appId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "currentVersionId" UUID,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Apps_pkey" PRIMARY KEY ("appId")
);

CREATE TABLE "AppVersions" (
    "appVersionId" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "changeSummary" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppVersions_pkey" PRIMARY KEY ("appVersionId")
);

CREATE TABLE "DataEntities" (
    "dataEntityId" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "mine" JSONB NOT NULL DEFAULT '{}',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "DataEntities_pkey" PRIMARY KEY ("dataEntityId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Apps_userId_name_key" ON "Apps"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AppVersions_appId_version_key" ON "AppVersions"("appId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DataEntities_appId_type_key_key" ON "DataEntities"("appId", "type", "key");

-- AddForeignKey
ALTER TABLE "Apps" ADD CONSTRAINT "Apps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppVersions" ADD CONSTRAINT "AppVersions_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Apps"("appId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataEntities" ADD CONSTRAINT "DataEntities_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Apps"("appId") ON DELETE CASCADE ON UPDATE CASCADE;
