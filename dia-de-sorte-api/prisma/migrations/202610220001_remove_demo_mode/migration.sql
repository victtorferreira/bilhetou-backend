BEGIN;
-- Renames preserve IDs, ownership, selections, numbers and existing order links.
ALTER TYPE "TicketStatus" RENAME VALUE 'ASSIGNED_DEMO' TO 'ASSIGNED';
ALTER TABLE "DemoParticipant" RENAME TO "Participant";
ALTER TABLE "Participant" RENAME CONSTRAINT "DemoParticipant_pkey" TO "Participant_pkey";
ALTER TABLE "Participant" RENAME CONSTRAINT "DemoParticipant_organizationId_fkey" TO "Participant_organizationId_fkey";
ALTER INDEX "DemoParticipant_organizationId_idx" RENAME TO "Participant_organizationId_idx";
ALTER TABLE "DemoOrder" RENAME TO "Order";
ALTER TABLE "Order" RENAME CONSTRAINT "DemoOrder_pkey" TO "Order_pkey";
ALTER TABLE "Order" RENAME CONSTRAINT "DemoOrder_campaignId_fkey" TO "Order_campaignId_fkey";
ALTER TABLE "Order" RENAME CONSTRAINT "DemoOrder_participantId_fkey" TO "Order_participantId_fkey";
ALTER INDEX "DemoOrder_participantId_idempotencyKey_key" RENAME TO "Order_participantId_idempotencyKey_key";
ALTER TABLE "Ticket" RENAME COLUMN "demoOrderId" TO "orderId";
ALTER TABLE "Ticket" RENAME CONSTRAINT "Ticket_demoOrderId_fkey" TO "Ticket_orderId_fkey";
ALTER TABLE "Campaign" ALTER COLUMN "rulesVersion" SET DEFAULT 'v1';
ALTER TABLE "Campaign" ALTER COLUMN "ticketPriceCents" DROP DEFAULT;
ALTER TABLE "Campaign" ADD COLUMN "prizeCents" INTEGER CHECK ("prizeCents" IS NULL OR "prizeCents" >= 0);
ALTER TABLE "Campaign" ADD COLUMN "legacySample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "legacySample" BOOLEAN NOT NULL DEFAULT false;
-- Archive only campaigns created by the known seeders. No deletion or renumbering.
UPDATE "Campaign" SET "legacySample" = true, status = 'ARCHIVED'
WHERE "rulesVersion" = 'demo-bootstrap-v1'
   OR ("rulesVersion" LIKE 'demo-%' AND name IN ('Bilhetou · Campanha DEMO', 'Bilhetou Â· Campanha DEMO'));
UPDATE "Order" o SET "legacySample" = true FROM "Campaign" c WHERE c.id = o."campaignId" AND c."legacySample";
UPDATE "Organization" SET name = 'Bilhetou' WHERE name IN ('Bilhetou — demonstração', 'Organização demonstrativa');
-- Audit snapshots are immutable and retain their original terminology.
COMMIT;
