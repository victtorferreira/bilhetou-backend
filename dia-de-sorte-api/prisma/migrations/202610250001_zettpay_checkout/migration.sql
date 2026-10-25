ALTER TABLE "Order" ADD COLUMN "paymentRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "paymentStatus" VARCHAR(24) NOT NULL DEFAULT 'UNPAID';
CREATE TABLE "ZettpayPayment" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'CREATING',
  "providerId" VARCHAR(160),
  "providerStatus" VARCHAR(64),
  "qrCode" TEXT,
  "paidAt" TIMESTAMP(3),
  "lastError" VARCHAR(160),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ZettpayPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ZettpayPayment_amount_check" CHECK ("amountCents" >= 100),
  CONSTRAINT "ZettpayPayment_status_check" CHECK ("status" IN ('CREATING','PENDING','PAID','UNKNOWN')),
  CONSTRAINT "ZettpayPayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ZettpayPayment_orderId_key" ON "ZettpayPayment"("orderId");
CREATE UNIQUE INDEX "ZettpayPayment_providerId_key" ON "ZettpayPayment"("providerId");
CREATE INDEX "ZettpayPayment_status_createdAt_idx" ON "ZettpayPayment"("status", "createdAt");
