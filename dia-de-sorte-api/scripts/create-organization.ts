import 'dotenv/config';
import { isUUID } from 'class-validator';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
async function main() {
  const id = process.env.PUBLIC_ORGANIZATION_ID || process.env.ADMIN_ORGANIZATION_ID;
  const name = process.env.ORGANIZATION_NAME?.trim();
  if (!id || !isUUID(id) || !name || name.length > 120) throw new Error('Configure PUBLIC_ORGANIZATION_ID com UUID e ORGANIZATION_NAME com o nome da organização (até 120 caracteres).');
  const organization = await prisma.organization.upsert({ where: { id }, create: { id, name }, update: {} });
  console.log(JSON.stringify({ organizationId: organization.id, name: organization.name }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
