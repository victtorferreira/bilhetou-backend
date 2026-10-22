const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateImport } = require('../dist/tickets/ticket-import');
const { generateTickets } = require('../dist/tickets/ticket-generator');
const { AdminTicketService } = require('../dist/tickets/admin-ticket.service');
const { AdminAuth, AdminSessionStore } = require('../dist/tickets/admin-auth');
const row = (serial = 'DS000001', numbers = ['0038', '1123', '6789', '9876']) => ({ serial, numbers });

test('four unique strings preserve leading zeros', () => {
  const report = validateImport([row()], []);
  assert.equal(report.rejected, 0);
  assert.equal(report.valid[0].numbers[0], '0038');
});
test('reject duplicates inside ticket and across campaign positions, with owner and line', () => {
  assert.equal(validateImport([row('BAD', ['0038','0038','1111','2222'])], []).rejected, 1);
  const report = validateImport([row()], [{ serial: 'OWNER', numbers: [{ value: '6789' }] }]);
  assert.equal(report.rejected, 1);
  assert.match(report.errors[0].reasons.join(), /6789.*2.*OWNER/);
});
test('reject wrong length and non-digit numbers', () => {
  for (const number of ['038', '00038', 'ABCD', '１２３４', ' 038']) assert.equal(validateImport([row('BAD', [number,'1111','2222','3333'])], []).rejected, 1);
  assert.equal(validateImport([row('BAD', ['1111','2222','3333'])], []).rejected, 1);
});
test('duplicate numbers and serials across CSV rows report physical line and preserve valid rows', () => {
  const report = validateImport([row(), { ...row('DS000002'), line: 15 }, row('DS000001', ['0001','0002','0003','0004'])], []);
  assert.equal(report.valid.length, 1); assert.equal(report.rejected, 2);
  assert.equal(report.errors[0].line, 15); assert.equal(report.duplicateNumbers.length, 4);
});
test('campaign scope permits reuse; capacity never exceeds 2500', () => {
  assert.equal(validateImport([row()], []).valid.length, 1);
  assert.equal(validateImport([row()], []).valid.length, 1);
  assert.equal(validateImport([row()], Array.from({ length: 2500 }, (_, i) => ({ serial: `OLD${i}`, numbers: [] }))).rejected, 1);
  assert.throws(() => generateTickets({ quantity: 1, prefix: 'BIL', uniqueNumbers: false }, Array.from({ length: 2500 }, (_, i) => ({ serial: `T${i}`, numbers: [] }))));
});
test('legacy false flag cannot disable campaign exclusivity', () => {
  const batch = generateTickets({ quantity: 1000, prefix: 'BIL', uniqueNumbers: false }, [{ serial: 'OLD', numbers: [{ value: '0000' }] }], () => 0);
  const numbers = batch.flatMap(t => t.numbers);
  assert.equal(new Set(numbers).size, 4000); assert.ok(!numbers.includes('0000'));
});
test('organization boundary is checked before number lookup', async () => {
  let lookedUp = false;
  const service = new AdminTicketService({ campaign: { findFirst: async ({ where }) => { assert.equal(where.organizationId, 'ORG2'); return null; } }, ticketNumber: { findUnique: async () => { lookedUp = true; } } });
  await assert.rejects(service.search('ORG2', 'CAMPAIGN1', '0038'), /Campanha/);
  assert.equal(lookedUp, false);
});
test('draw replay returns immutable snapshot; changing number is rejected', async () => {
  const original = { id: 'CHECK', number: '0038', snapshot: { status: 'AVAILABLE' } };
  const tx = { $queryRaw: async () => [], campaign: { findFirst: async () => ({ id: 'C' }) }, drawCheck: { findUnique: async () => original } };
  const service = new AdminTicketService({ $transaction: async callback => callback(tx) });
  assert.equal(await service.check('ORG', 'C', 'REF', '0038', 'admin'), original);
  await assert.rejects(service.check('ORG', 'C', 'REF', '1123', 'admin'), /referência/);
});
test('draw distinguishes available, demo assigned before/after closing and missing numbers', async () => {
  for (const ticket of [null, { id: 'T', serial: 'DS1', status: 'AVAILABLE', assignedAt: null }, { id: 'T', serial: 'DS1', status: 'ASSIGNED', assignedAt: new Date('2020-01-01') }, { id: 'T', serial: 'DS1', status: 'ASSIGNED', assignedAt: new Date('2020-01-03') }]) {
    const tx = { $queryRaw: async () => [], campaign: { findFirst: async () => ({ status: 'CLOSED', closesAt: new Date('2020-01-02') }) }, drawCheck: { findUnique: async () => null, create: async ({ data }) => data }, ticketNumber: { findUnique: async () => ticket ? { ticket } : null } };
    const result = await new AdminTicketService({ $transaction: async cb => cb(tx) }).check('ORG', 'C', 'REF', '0038', 'admin');
    assert.equal(result.snapshot.sold, false); assert.equal(result.snapshot.eligible, false);
    assert.equal(result.snapshot.assignedBeforeClose, !!ticket?.assignedAt && ticket.assignedAt < new Date('2020-01-02'));
    assert.equal(result.snapshot.serial, ticket?.serial ?? null);
  }
});
test('administrator credential creates a server session; forged cookie fails', () => {
  const previous = { key: process.env.ADMIN_ACCESS_KEY, org: process.env.ADMIN_ORGANIZATION_ID };
  try {
    process.env.ADMIN_ACCESS_KEY = 'a'.repeat(40); process.env.ADMIN_ORGANIZATION_ID = randomUUID();
    const auth = new AdminAuth(new AdminSessionStore());
    assert.throws(() => auth.login('wrong', 'test'));
    const token = auth.login('a'.repeat(40), 'test');
    const req = { headers: { cookie: `bilhetou_admin=${token}` } };
    const context = { switchToHttp: () => ({ getRequest: () => req }) };
    assert.equal(auth.canActivate(context), true); assert.equal(req.admin.organizationId, process.env.ADMIN_ORGANIZATION_ID);
    auth.logout(req); assert.throws(() => auth.canActivate(context));
    req.headers.cookie = 'bilhetou_admin=forged'; assert.throws(() => auth.canActivate(context));
  } finally {
    if (previous.key === undefined) delete process.env.ADMIN_ACCESS_KEY; else process.env.ADMIN_ACCESS_KEY = previous.key;
    if (previous.org === undefined) delete process.env.ADMIN_ORGANIZATION_ID; else process.env.ADMIN_ORGANIZATION_ID = previous.org;
  }
});

test('PostgreSQL enforces concurrent uniqueness, cross-campaign reuse, cardinality and composite FK', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { PrismaClient } = require('../dist/generated/prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
  const org = await prisma.organization.create({ data: { name: `exclusivity-${randomUUID()}` } });
  const campaigns = await Promise.all([0,1].map(i => prisma.campaign.create({ data: { ticketPriceCents: 250, name: `TEST${i}`, organizationId: org.id } })));
  const create = (campaignId, serial, numbers) => prisma.$transaction(async tx => {
    const ticket = await tx.ticket.create({ data: { campaignId, serial } });
    await tx.ticketNumber.createMany({ data: numbers.map((value, i) => ({ ticketId: ticket.id, campaignId, value, position: i + 1 })) });
    return ticket;
  });
  try {
    const contenders = await Promise.allSettled([create(campaigns[0].id,'A',row().numbers), create(campaigns[0].id,'B',row().numbers)]);
    assert.equal(contenders.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(contenders.filter(r => r.status === 'rejected').length, 1);
    const ticket = await create(campaigns[1].id,'C',row().numbers);
    assert.equal((await prisma.ticketNumber.findUnique({ where: { campaignId_value: { campaignId: campaigns[1].id, value: '0038' } } })).ticketId, ticket.id);
    await assert.rejects(create(campaigns[0].id,'SHORT',['0001','0002','0003']));
    await assert.rejects(create(campaigns[0].id,'REPEAT',['0001','0001','0002','0003']));
    await assert.rejects(create(campaigns[0].id,'FORMAT',['001','0002','0003','0004']));
    await assert.rejects(prisma.ticketNumber.updateMany({ where: { ticketId: ticket.id }, data: { campaignId: campaigns[0].id } }));
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'ASSIGNED', assignedAt: new Date() } });
    await assert.rejects(prisma.ticketNumber.updateMany({ where: { ticketId: ticket.id, position: 1 }, data: { value: '0001' } }));
    // Cleanup only explicitly created fixtures; restore the fixture's status first.
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'AVAILABLE', assignedAt: null } });
  } finally {
    const ids = campaigns.map(c => c.id);
    await prisma.ticket.deleteMany({ where: { campaignId: { in: ids } } });
    await prisma.campaign.deleteMany({ where: { id: { in: ids } } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.$disconnect();
  }
});
