BEGIN;
CREATE TABLE "DemoParticipant" (
  id UUID PRIMARY KEY,
  "organizationId" UUID NOT NULL REFERENCES "Organization"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(11) NOT NULL CHECK (phone ~ '^[0-9]{2}9[0-9]{8}$'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DemoParticipant_organizationId_idx" ON "DemoParticipant"("organizationId");
CREATE TABLE "ParticipantSession" (
  id UUID PRIMARY KEY,
  "tokenHash" CHAR(64) NOT NULL,
  "participantId" UUID NOT NULL REFERENCES "DemoParticipant"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "campaignId" UUID REFERENCES "Campaign"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "selectedIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "selectionKey" UUID NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ParticipantSession_tokenHash_key" ON "ParticipantSession"("tokenHash");
CREATE INDEX "ParticipantSession_expiresAt_idx" ON "ParticipantSession"("expiresAt");
ALTER TABLE "DemoOrder" ADD COLUMN "participantId" UUID;
ALTER TABLE "DemoOrder" ADD COLUMN "idempotencyKey" UUID;
ALTER TABLE "DemoOrder" ADD CONSTRAINT "DemoOrder_participantId_fkey"
  FOREIGN KEY ("participantId") REFERENCES "DemoParticipant"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "DemoOrder_participantId_idempotencyKey_key" ON "DemoOrder"("participantId", "idempotencyKey");
COMMIT;
