import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
async function main() {
  const [campaignId, reference, ...numbers] = process.argv.slice(2);
  if (!campaignId || !reference || numbers.length === 0 || !numbers.every(n => /^\d{4}$/.test(n))) throw new Error('Uso: npm run result:demo -- <campaignId> <referencia> <numero4> [numero4...]');
  const result = await prisma.$transaction(async tx => {
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (campaign.status === 'OPEN') throw new Error('Encerre a campanha antes de registrar resultados');
    const draw = await tx.draw.create({ data: { campaignId, reference, status: 'RECORDED', results: { create: numbers.map((number, i) => ({ position: i + 1, number })) } } });
    const matches = await tx.ticketNumber.findMany({ where: { value: { in: numbers }, ticket: { campaignId, status: 'ASSIGNED_DEMO', assignedAt: { not: null } } }, select: { ticketId: true, value: true } });
    const unique = [...new Map(matches.map(m => [`${m.ticketId}:${m.value}`, m])).values()];
    for (const m of unique) await tx.ticketMatch.create({ data: { drawId: draw.id, ticketId: m.ticketId, number: m.value } });
    return { drawId: draw.id, matchingNumberOccurrences: unique.length, verifiedWinners: 0 };
  });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
