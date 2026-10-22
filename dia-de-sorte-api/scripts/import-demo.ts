import 'dotenv/config';
import { validateImport } from '../src/tickets/ticket-import';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
async function main() {
  const file = process.argv[2] || 'sample/bilhetes.csv';
  const rows = readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1);
  const parsed = rows.map((row, index) => {
    const [serial, ...nums] = row.split(',').map(s => s.trim());
    if (!serial || nums.length !== 4 || !nums.every(n => /^\d{4}$/.test(n))) throw new Error(`Linha CSV ${index + 2} inválida`);
    return { serial, nums };
  });
  if (new Set(parsed.map(r => r.serial)).size !== parsed.length) throw new Error('Seriais duplicados no CSV');
  const report = validateImport(parsed.map(r => ({ serial: r.serial, numbers: r.nums })), []);
  if (report.rejected) throw new Error(JSON.stringify(report.errors, null, 2));
  const org = await prisma.organization.create({ data: { name: 'Organização demonstrativa' } });
  const campaign = await prisma.campaign.create({ data: { organizationId: org.id, name: 'Bilhetou · Campanha DEMO', rulesVersion: 'demo-v1', status: 'OPEN', ticketPriceCents: 200 } });
  await prisma.$transaction(async tx => {
    for (const row of parsed) {
      // The composite parent relation supplies both ticketId and campaignId.
      await tx.ticket.create({ data: { campaignId: campaign.id, serial: row.serial, numbers: { create: row.nums.map((value, idx) => ({ position: idx + 1, value })) } } });
    }
  });
  console.log(JSON.stringify({ campaignId: campaign.id, ticketsImported: parsed.length }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
