-- CreateTable
CREATE TABLE "HealthChecks" (
    "name" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "detail" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "maxAgeHours" INTEGER NOT NULL,
    "toldProblem" BOOLEAN NOT NULL DEFAULT false,
    "toldAt" TIMESTAMP(3),

    CONSTRAINT "HealthChecks_pkey" PRIMARY KEY ("name")
);
