-- CreateTable
CREATE TABLE "Bills" (
    "billId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "issuerKey" TEXT NOT NULL,
    "billKey" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "dueDate" DATE,
    "period" TEXT,
    "reference" TEXT,
    "messageId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "runId" UUID,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bills_pkey" PRIMARY KEY ("billId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Bills_userId_billKey_key" ON "Bills"("userId", "billKey");

-- CreateIndex
CREATE INDEX "Bills_userId_issuerKey_idx" ON "Bills"("userId", "issuerKey");

-- AddForeignKey
ALTER TABLE "Bills" ADD CONSTRAINT "Bills_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
