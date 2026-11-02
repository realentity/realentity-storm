-- CreateTable
CREATE TABLE "WatchedProducts" (
    "watchedProductId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "targetPrice" DECIMAL(12,2),
    "currency" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchedProducts_pkey" PRIMARY KEY ("watchedProductId")
);

-- CreateTable
CREATE TABLE "WatchedOffers" (
    "watchedOfferId" UUID NOT NULL,
    "watchedProductId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "select" JSONB,
    "lastPrice" DECIMAL(12,2),
    "lastCurrency" TEXT,
    "lastInStock" BOOLEAN,
    "lastTitle" TEXT,
    "lastProblem" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchedOffers_pkey" PRIMARY KEY ("watchedOfferId")
);

-- CreateIndex
CREATE INDEX "WatchedProducts_userId_idx" ON "WatchedProducts"("userId");

-- CreateIndex
CREATE INDEX "WatchedOffers_watchedProductId_idx" ON "WatchedOffers"("watchedProductId");

-- AddForeignKey
ALTER TABLE "WatchedProducts" ADD CONSTRAINT "WatchedProducts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchedOffers" ADD CONSTRAINT "WatchedOffers_watchedProductId_fkey" FOREIGN KEY ("watchedProductId") REFERENCES "WatchedProducts"("watchedProductId") ON DELETE CASCADE ON UPDATE CASCADE;
