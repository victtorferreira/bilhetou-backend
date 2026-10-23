CREATE TABLE "WhatsappWelcome" (
  "id" UUID NOT NULL,
  "participantId" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "phone" VARCHAR(11) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "consentVersion" TEXT NOT NULL DEFAULT 'welcome-v1',
  "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "providerMessageId" TEXT,
  "lastError" TEXT,
  CONSTRAINT "WhatsappWelcome_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WhatsappWelcome_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WhatsappWelcome_organizationId_phone_key" ON "WhatsappWelcome"("organizationId", "phone");
CREATE INDEX "WhatsappWelcome_status_nextAttemptAt_idx" ON "WhatsappWelcome"("status", "nextAttemptAt");
