-- CreateTable
CREATE TABLE "DataRecords" (
    "dataRecordId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "collection" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "DataRecords_pkey" PRIMARY KEY ("dataRecordId")
);

-- CreateTable
CREATE TABLE "DataPoints" (
    "dataPointId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "collection" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataPoints_pkey" PRIMARY KEY ("dataPointId")
);

-- CreateTable
CREATE TABLE "HttpCaches" (
    "httpCacheId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "etag" TEXT,
    "lastModified" TEXT,
    "contentType" TEXT NOT NULL,
    "body" BYTEA NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HttpCaches_pkey" PRIMARY KEY ("httpCacheId")
);

-- CreateIndex
CREATE UNIQUE INDEX "DataRecords_userId_collection_key_key" ON "DataRecords"("userId", "collection", "key");

-- CreateIndex
CREATE INDEX "DataPoints_userId_collection_key_at_idx" ON "DataPoints"("userId", "collection", "key", "at");

-- CreateIndex
CREATE UNIQUE INDEX "HttpCaches_userId_url_key" ON "HttpCaches"("userId", "url");

-- AddForeignKey
ALTER TABLE "DataRecords" ADD CONSTRAINT "DataRecords_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataPoints" ADD CONSTRAINT "DataPoints_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpCaches" ADD CONSTRAINT "HttpCaches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

