const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { AdminParticipantsService } = require('../dist/participants/admin-participants.service');

const person = { id: randomUUID(), name: 'Maria Silva', phone: '98999999999', createdAt: new Date('2026-10-22T12:00:00Z') };
const totals = { _count: { _all: 2 }, _sum: { quantity: 3, totalCents: 900 } };
test('participant list is scoped, paginated, searchable by formatted phone and masks contact server-side', async () => {
  let where;
  const tx = {
    participant: {
      count: async input => { where = input.where; return 41; },
      findMany: async input => { assert.equal(input.skip, 40); assert.equal(input.take, 20); assert.equal(input.where, where); return [person]; },
    },
    order: {
      groupBy: async input => { assert.equal(input.where.campaign.organizationId, 'ORG'); assert.equal(input.where.legacySample, false); assert.deepEqual(input.where.participantId.in, [person.id]); return [{ participantId: person.id, ...totals }]; },
      aggregate: async input => { assert.equal(input.where.participant.organizationId, 'ORG'); return totals; },
    },
  };
  const result = await new AdminParticipantsService({ $transaction: async cb => cb(tx) }).list('ORG', { page: 99, query: '+55 (98) 99999-9999', activity: 'all', campaignScope: 'all' });
  assert.equal(where.organizationId, 'ORG');
  assert.equal(where.AND[0].OR[1].phone.contains, '98999999999');
  assert.equal(result.page, 3); assert.equal(result.totalPages, 3);
  assert.equal(result.items[0].phoneMasked, '(98) 9****-9999');
  assert.equal(result.items[0].phone, undefined); assert.ok(!JSON.stringify(result).includes(person.phone));
  assert.equal(result.items[0].orders, 2); assert.equal(result.items[0].tickets, 3);
});
test('without-orders filter keeps participants without orders in selected campaign', async () => {
  const campaignId = randomUUID();
  const tx = { campaign: { findFirst: async ({ where }) => { assert.equal(where.organizationId, 'ORG'); assert.equal(where.legacySample, false); return { id: campaignId }; } }, participant: { count: async ({ where }) => { assert.equal(where.AND.length, 1); assert.equal(where.AND[0].orders.none.campaign.id, campaignId); return 0; }, findMany: async () => [] }, order: { aggregate: async () => ({ _count: { _all: 0 }, _sum: { quantity: null } }) } };
  const result = await new AdminParticipantsService({ $transaction: async cb => cb(tx) }).list('ORG', { page: 1, query: '', activity: 'without_orders', campaignId });
  assert.deepEqual(result.items, []); assert.equal(result.summary.orders, 0); assert.equal(result.page, 1);
});

test('current campaign excludes previous purchases while retaining registrations with zero activity', async () => {
  const campaign = { id: randomUUID(), name: 'Nova campanha', status: 'OPEN', closesAt: null };
  const zero = { _count: { _all: 0 }, _sum: { quantity: null } };
  const tx = {
    campaign: { findFirst: async ({ where, orderBy }) => {
      assert.equal(where.organizationId, 'ORG'); assert.equal(where.status, 'OPEN');
      assert.equal(where.deletedAt, null); assert.equal(where.legacySample, false);
      assert.ok(where.OR[1].closesAt.gt instanceof Date); assert.equal(orderBy[0].createdAt, 'desc');
      return campaign;
    } },
    participant: {
      count: async ({ where }) => { assert.deepEqual(where.AND, []); return 1; },
      findMany: async () => [person],
    },
    order: {
      groupBy: async ({ where }) => { assert.equal(where.campaign.id, campaign.id); return []; },
      aggregate: async ({ where }) => { assert.equal(where.campaign.id, campaign.id); return zero; },
    },
  };
  const service = new AdminParticipantsService({ $transaction: async cb => cb(tx) });
  const result = await service.list('ORG', { page: 1, query: '', activity: 'all' });
  assert.deepEqual(result.campaignScope, { mode: 'current', active: true, campaign: { id: campaign.id, name: campaign.name } });
  assert.equal(result.items[0].orders, 0); assert.equal(result.items[0].tickets, 0);
  assert.equal(result.summary.tickets, 0);
  // Manually selecting a campaign also preserves people without purchases.
  tx.campaign.findFirst = async () => campaign;
  assert.equal((await service.list('ORG', { page: 1, query: '', activity: 'all', campaignId: campaign.id })).total, 1);
});

test('without active campaign, shows only the latest completed campaign or zero if none exists', async () => {
  const campaign = { id: randomUUID(), name: 'Última campanha', status: 'CLOSED', closesAt: new Date('2026-01-01') };
  let fallback = campaign;
  const tx = {
    campaign: { findFirst: async ({ where }) => {
      if (where.status === 'OPEN') return null;
      assert.deepEqual(where.status, { not: 'DRAFT' }); assert.equal(where.deletedAt, null);
      return fallback;
    } },
    participant: { count: async () => 1, findMany: async () => [person] },
    order: {
      groupBy: async ({ where }) => {
        if (fallback) { assert.equal(where.campaign.id, campaign.id); return [{ participantId: person.id, ...totals }]; }
        assert.deepEqual(where.id, { in: [] }); return [];
      },
      aggregate: async ({ where }) => {
        if (fallback) { assert.equal(where.campaign.id, campaign.id); return totals; }
        assert.deepEqual(where.id, { in: [] }); return { _count: { _all: 0 }, _sum: { quantity: null } };
      },
    },
  };
  const service = new AdminParticipantsService({ $transaction: async cb => cb(tx) });
  const result = await service.list('ORG', { page: 1, query: '', activity: 'all' });
  assert.equal(result.campaignScope.active, false); assert.equal(result.campaignScope.campaign.id, campaign.id);
  assert.equal(result.items[0].tickets, 3);
  fallback = null;
  const empty = await service.list('ORG', { page: 1, query: '', activity: 'all' });
  assert.equal(empty.campaignScope.campaign, null); assert.equal(empty.total, 1); assert.equal(empty.items[0].tickets, 0);
});
test('another organization cannot retrieve participant details, orders, tickets or filter by its campaign', async () => {
  const service = new AdminParticipantsService({ $transaction: async cb => cb({ participant: { findFirst: async ({ where }) => { assert.equal(where.organizationId, 'ORG'); return null; } }, campaign: { findFirst: async () => null } }) });
  await assert.rejects(service.detail('ORG', person.id), /Participante não encontrado/);
  await assert.rejects(service.orders('ORG', person.id, 1), /Participante não encontrado/);
  await assert.rejects(service.tickets('ORG', person.id, 1), /Participante não encontrado/);
  await assert.rejects(service.list('ORG', { page: 1, query: '', activity: 'all', campaignId: randomUUID() }), /Campanha não encontrada/);
});
test('authorized detail reveals contact only after organization ownership is established', async () => {
  let checked = false;
  const tx = { participant: { findFirst: async ({ where }) => { assert.deepEqual(where, { id: person.id, organizationId: 'ORG' }); checked = true; return person; } }, order: { aggregate: async ({ where }) => { assert.ok(checked); assert.equal(where.campaign.organizationId, 'ORG'); assert.equal(where.participantId, person.id); return totals; } } };
  const result = await new AdminParticipantsService({ $transaction: async cb => cb(tx) }).detail('ORG', person.id);
  assert.equal(result.phone, person.phone); assert.equal(result.verification, 'unverified'); assert.equal(result.summary.orderValueCents, 900);
});
test('HTTP protects every participant route, validates filters and ignores no client-supplied organization', async () => {
  require('reflect-metadata');
  const { Module, ValidationPipe } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { AdminAuth, AdminSessionStore } = require('../dist/tickets/admin-auth');
  const { AdminSessionController } = require('../dist/tickets/admin.controller');
  const { AdminParticipantsController } = require('../dist/participants/admin-participants.controller');
  const previous = { key: process.env.ADMIN_ACCESS_KEY, org: process.env.ADMIN_ORGANIZATION_ID };
  const organizationId = randomUUID();
  process.env.ADMIN_ACCESS_KEY = 'a'.repeat(40); process.env.ADMIN_ORGANIZATION_ID = organizationId;
  const scoped = org => { assert.equal(org, organizationId); return { items: [], total: 0 }; };
  class TestModule {}
  Module({ controllers: [AdminSessionController, AdminParticipantsController], providers: [AdminAuth, AdminSessionStore, { provide: AdminParticipantsService, useValue: { list: scoped, detail: scoped, orders: scoped, tickets: scoped } }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix('api'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  try {
    const base = `${await app.getUrl()}/api/admin`;
    for (const path of ['', `/${person.id}`, `/${person.id}/orders`, `/${person.id}/tickets`]) assert.equal((await fetch(`${base}/participants${path}`)).status, 401);
    const login = await fetch(`${base}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: process.env.ADMIN_ACCESS_KEY }) });
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    for (const path of ['', `/${person.id}`, `/${person.id}/orders`, `/${person.id}/tickets`]) assert.equal((await fetch(`${base}/participants${path}`, { headers })).status, 200);
    for (const query of ['page=0', 'page=1.5', 'activity=unknown', 'campaignId=invalid', 'campaignScope=unknown', `organizationId=${randomUUID()}`]) assert.equal((await fetch(`${base}/participants?${query}`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/participants/not-a-uuid`, { headers })).status, 400);
  } finally {
    await app.close();
    if (previous.key === undefined) delete process.env.ADMIN_ACCESS_KEY; else process.env.ADMIN_ACCESS_KEY = previous.key;
    if (previous.org === undefined) delete process.env.ADMIN_ORGANIZATION_ID; else process.env.ADMIN_ORGANIZATION_ID = previous.org;
  }
});

test('PostgreSQL: participant pagination, private contact, linked orders/tickets and organization isolation', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { PrismaClient } = require('../dist/generated/prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
  const service = new AdminParticipantsService(prisma);
  const orgs = await Promise.all([0, 1].map(i => prisma.organization.create({ data: { name: `Admin participants ${i}` } })));
  let campaign;
  try {
    const participants = Array.from({ length: 21 }, (_, i) => ({ id: randomUUID(), organizationId: orgs[0].id, name: `Pessoa ${i}`, phone: `119${String(i).padStart(8, '0')}` }));
    await prisma.participant.createMany({ data: participants });
    const foreign = await prisma.participant.create({ data: { organizationId: orgs[1].id, name: 'Pessoa externa', phone: participants[0].phone } });
    campaign = await prisma.campaign.create({ data: { organizationId: orgs[0].id, name: 'Campanha', ticketPriceCents: 300, status: 'OPEN' } });
    await prisma.$transaction(async tx => {
      const order = await tx.order.create({ data: { campaignId: campaign.id, participantId: participants[0].id, quantity: 1, totalCents: 300 } });
      const ticket = await tx.ticket.create({ data: { campaignId: campaign.id, serial: 'PART-000001', orderId: order.id } });
      await tx.ticketNumber.createMany({ data: ['0038','1123','6789','9876'].map((value, i) => ({ ticketId: ticket.id, campaignId: campaign.id, value, position: i + 1 })) });
      await tx.ticket.update({ where: { id: ticket.id }, data: { status: 'ASSIGNED', assignedAt: new Date() } });
    });
    const result = await service.list(orgs[0].id, { page: 2, query: '', activity: 'all' });
    assert.equal(result.total, 21); assert.equal(result.items.length, 1); assert.equal(result.summary.orders, 1);
    const searched = await service.list(orgs[0].id, { page: 1, query: participants[0].phone, activity: 'with_orders' });
    assert.equal(searched.total, 1); assert.equal(searched.items[0].phone, undefined);
    assert.equal((await service.detail(orgs[0].id, participants[0].id)).phone, participants[0].phone);
    assert.equal((await service.orders(orgs[0].id, participants[0].id, 1)).items[0].paymentStatus, 'UNPAID');
    assert.equal((await service.tickets(orgs[0].id, participants[0].id, 1)).items[0].numbers[0].value, '0038');
    await assert.rejects(service.detail(orgs[0].id, foreign.id), /Participante não encontrado/);
  } finally {
    if (campaign) {
      await prisma.ticket.updateMany({ where: { campaignId: campaign.id }, data: { status: 'AVAILABLE', assignedAt: null } });
      await prisma.ticket.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.order.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.campaign.delete({ where: { id: campaign.id } });
    }
    await prisma.participant.deleteMany({ where: { organizationId: { in: orgs.map(o => o.id) } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs.map(o => o.id) } } });
    await prisma.$disconnect();
  }
});
