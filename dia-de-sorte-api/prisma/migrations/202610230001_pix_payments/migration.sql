CREATE TABLE "PixPayment" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "requestKey" UUID NOT NULL,
  "environment" VARCHAR(16) NOT NULL,
  "description" VARCHAR(140) NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'CREATING',
  "providerId" VARCHAR(160),
  "brCode" TEXT,
  "expiresAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "lastError" VARCHAR(160),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PixPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PixPayment_amount_check" CHECK ("amountCents" BETWEEN 100 AND 1000000),
  CONSTRAINT "PixPayment_environment_check" CHECK ("environment" IN ('sandbox', 'production')),
  CONSTRAINT "PixPayment_status_check" CHECK ("status" IN ('CREATING','PENDING','PAID','EXPIRED','CANCELLED','FAILED','UNKNOWN')),
  CONSTRAINT "PixPayment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PixPayment_providerId_key" ON "PixPayment"("providerId");
CREATE UNIQUE INDEX "PixPayment_organizationId_requestKey_key" ON "PixPayment"("organizationId", "requestKey");
CREATE INDEX "PixPayment_organizationId_createdAt_idx" ON "PixPayment"("organizationId", "createdAt");
CREATE TABLE "PaymentWebhookEvent" (
  "id" VARCHAR(160) NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);
