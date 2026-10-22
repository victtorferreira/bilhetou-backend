-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('AVAILABLE', 'ASSIGNED_DEMO', 'VOID');

-- CreateEnum
CREATE TYPE "DrawStatus" AS ENUM ('PENDING', 'RECORDED', 'REVIEWED');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "ticketPriceCents" INTEGER NOT NULL DEFAULT 200,
    "rulesVersion" TEXT NOT NULL DEFAULT 'draft-v1',
    "closesAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "serial" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'AVAILABLE',
    "demoOrderId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" TIMESTAMP(3),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketNumber" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "value" CHAR(4) NOT NULL,

    CONSTRAINT "TicketNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoOrder" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Draw" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "status" "DrawStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Draw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DrawResult" (
    "id" UUID NOT NULL,
    "drawId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "number" CHAR(4) NOT NULL,

    CONSTRAINT "DrawResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketMatch" (
    "id" UUID NOT NULL,
    "drawId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "number" CHAR(4) NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TicketMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_organizationId_status_idx" ON "Campaign"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Ticket_campaignId_status_idx" ON "Ticket"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_campaignId_serial_key" ON "Ticket"("campaignId", "serial");

-- CreateIndex
CREATE INDEX "TicketNumber_value_idx" ON "TicketNumber"("value");

-- CreateIndex
CREATE UNIQUE INDEX "TicketNumber_ticketId_position_key" ON "TicketNumber"("ticketId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Draw_campaignId_reference_key" ON "Draw"("campaignId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "DrawResult_drawId_position_key" ON "DrawResult"("drawId", "position");

-- CreateIndex
CREATE INDEX "TicketMatch_drawId_idx" ON "TicketMatch"("drawId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketMatch_drawId_ticketId_number_key" ON "TicketMatch"("drawId", "ticketId", "number");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_demoOrderId_fkey" FOREIGN KEY ("demoOrderId") REFERENCES "DemoOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketNumber" ADD CONSTRAINT "TicketNumber_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemoOrder" ADD CONSTRAINT "DemoOrder_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draw" ADD CONSTRAINT "Draw_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawResult" ADD CONSTRAINT "DrawResult_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "Draw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMatch" ADD CONSTRAINT "TicketMatch_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "Draw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMatch" ADD CONSTRAINT "TicketMatch_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
