-- CreateTable
CREATE TABLE "ServiceHeartbeats" (
    "service" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceHeartbeats_pkey" PRIMARY KEY ("service")
);

