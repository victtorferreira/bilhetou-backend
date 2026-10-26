BEGIN;
ALTER TABLE "Order" ADD COLUMN "reservationExpiresAt" TIMESTAMP(3);
ALTER TABLE "Participant" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);
-- Existing priced public orders must never become free because a gateway was disabled.
UPDATE "Order" SET "paymentRequired" = true
WHERE "totalCents" > 0 AND "paymentStatus" = 'UNPAID'
  AND "legacySample" = false AND "participantId" IS NOT NULL;
UPDATE "Order" SET "reservationExpiresAt" = "createdAt" + INTERVAL '15 minutes'
WHERE "paymentRequired" = true AND "paymentStatus" = 'UNPAID';
CREATE INDEX "Order_paymentStatus_reservationExpiresAt_campaignId_idx"
  ON "Order"("paymentStatus", "reservationExpiresAt", "campaignId");
CREATE TABLE "RequestLimit" (
  "key" CHAR(64) NOT NULL PRIMARY KEY,
  "count" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "RequestLimit_expiresAt_idx" ON "RequestLimit"("expiresAt");
CREATE INDEX "Participant_organizationId_phone_idx" ON "Participant"("organizationId", "phone");
-- Historical checkboxes did not verify the recipient's ownership or consent.
UPDATE "WhatsappWelcome" SET "status" = 'CANCELLED', "lockedAt" = NULL,
  "lastError" = 'Envio suspenso: telefone sem verificação de titularidade.'
WHERE "status" IN ('PENDING', 'PROCESSING');
COMMIT;
