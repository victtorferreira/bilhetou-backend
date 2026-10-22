import 'dotenv/config';
import { isUUID } from 'class-validator';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { generateTickets } from '../src/tickets/ticket-generator';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
async function main() {
  const organizationId = process.env.DEMO_ORGANIZATION_ID || process.env.ADMIN_ORGANIZATION_ID;
  if (!organizationId || !isUUID(organizationId)) throw new Error('Configure DEMO_ORGANIZATION_ID com um UUID antes de preparar a demonstração.');
  const quantity = Number(process.env.DEMO_SETUP_TICKETS || 20);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw new Error('DEMO_SETUP_TICKETS deve estar entre 1 e 1000.');
  const result = await prisma.$transaction(async tx => {
    await tx.organization.upsert({ where: { id: organizationId }, create: { id: organizationId, name: 'Bilhetou — demonstração' }, update: {} });
    // One bootstrap per organization, serialized even on repeated starts.
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId}::uuid FOR UPDATE`;
    let campaign = process.env.PUBLIC_CAMPAIGN_ID
      ? await tx.campaign.findFirst({ where: { id: process.env.PUBLIC_CAMPAIGN_ID, organizationId, rulesVersion: { startsWith: 'demo-' } } })
      : await tx.campaign.findFirst({ where: { organizationId, rulesVersion: 'demo-bootstrap-v1' } });
    if (!campaign && process.env.PUBLIC_CAMPAIGN_ID) throw new Error('PUBLIC_CAMPAIGN_ID não corresponde a uma campanha demonstrativa desta organização.');
    campaign ??= await tx.campaign.create({ data: { organizationId, name: 'Bilhetou — campanha de testes', rulesVersion: 'demo-bootstrap-v1', status: 'OPEN', ticketPriceCents: 200 } });
    await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaign.id}::uuid FOR UPDATE`;
    const stock = await tx.ticket.findMany({ where: { campaignId: campaign.id }, select: { serial: true, numbers: { select: { value: true } } } });
    let created = 0;
    if (campaign.status === 'OPEN' && (!campaign.closesAt || campaign.closesAt > new Date()) && stock.length < quantity) {
      const tickets = generateTickets({ quantity: quantity - stock.length, prefix: 'TESTE', uniqueNumbers: true }, stock);
      await tx.ticket.createMany({ data: tickets.map(t => ({ id: t.id, campaignId: campaign!.id, serial: t.serial })) });
      await tx.ticketNumber.createMany({ data: tickets.flatMap(t => t.numbers.map((value, i) => ({ ticketId: t.id, campaignId: campaign!.id, value, position: i + 1 }))) });
      created = tickets.length;
    }
    return { organizationId, campaignId: campaign.id, createdTickets: created, demoOnly: true };
  }, { timeout: 30000 });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
