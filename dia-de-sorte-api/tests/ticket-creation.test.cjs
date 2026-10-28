const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { generateTickets } = require('../dist/tickets/ticket-generator');
const { AdminAuth, AdminSessionStore } = require('../dist/tickets/admin-auth');
const { allowedOrigins } = require('../dist/security/origins');

test('generator validates quantities and serial prefixes', () => {
  const base = { quantity: 1, prefix: 'BIL', uniqueNumbers: false };
  for (const quantity of [0, -1, 1.2, 2501, NaN]) assert.throws(() => generateTickets({ ...base, quantity }, []));
  for (const prefix of ['', '12', 'A'.repeat(13), '=formula', 'A B']) assert.throws(() => generateTickets({ ...base, prefix }, []));
});

test('generator creates four padded distinct numbers and monotonic serials', () => {
  const existing = [{ serial: 'BIL-000003', numbers: [{ value: '0000' }] }];
  const batch = generateTickets({ quantity: 1000, prefix: 'bil', uniqueNumbers: false }, existing, () => 0);
  assert.equal(batch[0].serial, 'BIL-000004');
  assert.equal(batch[999].serial, 'BIL-001003');
  assert.equal(new Set(batch.map(ticket => ticket.id)).size, 1000);
  for (const ticket of batch) {
    assert.equal(new Set(ticket.numbers).size, 4);
    assert.ok(ticket.numbers.every(number => /^\d{4}$/.test(number)));
  }
});

test('global unique rule excludes existing numbers and handles exhausted pool', () => {
  const stock = [{ serial: 'OLD-000001', numbers: [{ value: '0000' }, { value: '0001' }] }];
  const batch = generateTickets({ quantity: 100, prefix: 'BIL', uniqueNumbers: true }, stock, () => 0);
  const numbers = batch.flatMap(ticket => ticket.numbers);
  assert.equal(new Set(numbers).size, 400);
  assert.ok(!numbers.includes('0000') && !numbers.includes('0001'));
  const exhausted = [{ serial: 'FULL', numbers: Array.from({ length: 10000 }, (_, i) => ({ value: String(i).padStart(4, '0') })) }];
  assert.throws(() => generateTickets({ quantity: 1, prefix: 'BIL', uniqueNumbers: true }, exhausted));
});

test('generator refuses stock overflow and exhausted serial prefix', () => {
  const base = { quantity: 1, prefix: 'BIL', uniqueNumbers: false };
  assert.throws(() => generateTickets(base, [{ serial: 'BIL-999999', numbers: [] }]));
  assert.throws(() => generateTickets(base, Array.from({ length: 5000 }, (_, i) => ({ serial: `T-${i}`, numbers: [] }))));
});

test('a full batch covers all 10000 numbers exactly once and respects existing stock', () => {
  const input = { quantity: 2500, prefix: 'BIL', uniqueNumbers: true };
  const batch = generateTickets(input, []);
  assert.equal(batch.length, 2500);
  assert.equal(batch[2499].serial, 'BIL-002500');
  const numbers = batch.flatMap(ticket => ticket.numbers);
  assert.equal(numbers.length, 10000); assert.equal(new Set(numbers).size, 10000);
  assert.ok(numbers.includes('0000')); assert.ok(numbers.includes('9999'));
  const stock = [{ serial: 'BIL-000001', numbers: ['0000', '0001', '0002', '0003'].map(value => ({ value })) }];
  assert.throws(() => generateTickets(input, stock), /2.500/);
  assert.equal(generateTickets({ ...input, quantity: 2499 }, stock).length, 2499);
});

test('HTTP accepts and confirms 2500 tickets with the longest prefix within existing payload limits', async () => {
  require('reflect-metadata');
  const { Module, ValidationPipe } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { AdminTicketsController } = require('../dist/tickets/admin.controller');
  const { AdminTicketService } = require('../dist/tickets/admin-ticket.service');
  const { TicketCreationService } = require('../dist/tickets/ticket-creation.service');
  const { configureHttpSecurity } = require('../dist/security/http-security');
  const previous = { key: process.env.ADMIN_ACCESS_KEY, org: process.env.ADMIN_ORGANIZATION_ID };
  const organizationId = randomUUID(), campaignId = randomUUID();
  process.env.ADMIN_ACCESS_KEY = 'a'.repeat(40); process.env.ADMIN_ORGANIZATION_ID = organizationId;
  const tickets = [], numbers = [];
  const tx = {
    $queryRaw: async () => [],
    campaign: { findUnique: async () => ({ id: campaignId, organizationId, status: 'OPEN' }) },
    ticket: {
      count: async () => tickets.length,
      findMany: async ({ where }) => where.id ? tickets.filter(t => where.id.in.includes(t.id)) : tickets,
      findFirst: async () => null,
      createMany: async ({ data }) => { tickets.push(...data); return { count: data.length }; },
    },
    ticketNumber: {
      findFirst: async () => null,
      createMany: async ({ data }) => { numbers.push(...data); return { count: data.length }; },
    },
  };
  const creation = new TicketCreationService({ $transaction: async cb => cb(tx) });
  const sessions = new AdminSessionStore();
  const auth = new AdminAuth(sessions);
  const token = auth.login(process.env.ADMIN_ACCESS_KEY, 'full-batch-test');
  class TestModule {}
  Module({ controllers: [AdminTicketsController], providers: [
    { provide: AdminAuth, useValue: auth },
    { provide: AdminSessionStore, useValue: sessions },
    { provide: AdminTicketService, useValue: { campaign: async (org, id) => { assert.equal(org, organizationId); assert.equal(id, campaignId); } } },
    { provide: TicketCreationService, useValue: creation },
  ] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false, bodyParser: false, abortOnError: false });
  configureHttpSecurity(app);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  try {
    const base = `${await app.getUrl()}/api/admin/ticket-batches`;
    const post = async (path, body) => {
      const response = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', Cookie: `bilhetou_admin=${token}` }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const input = { campaignId, quantity: 2500, prefix: 'ABCDEFGHIJKL', uniqueNumbers: true };
    assert.equal((await post('preview', { ...input, quantity: 2501 })).status, 400);
    const preview = await post('preview', input);
    assert.equal(preview.status, 201); assert.equal(preview.body.tickets.length, 2500);
    assert.ok(preview.body.token.length < 400000);
    assert.ok(Buffer.byteLength(JSON.stringify({ token: preview.body.token })) < 512 * 1024);
    assert.equal(tickets.length, 0);
    const confirmed = await post('confirm', { token: preview.body.token });
    assert.equal(confirmed.status, 201); assert.equal(confirmed.body.created, 2500);
    assert.equal(tickets.length, 2500); assert.equal(numbers.length, 10000);
    assert.equal(new Set(numbers.map(n => n.value)).size, 10000);
    const replay = await post('confirm', { token: preview.body.token });
    assert.equal(replay.status, 201); assert.equal(replay.body.replayed, true);
    assert.equal(tickets.length, 2500);
    assert.equal((await post('preview', { ...input, quantity: 1 })).status, 409);
  } finally {
    await app.close();
    if (previous.key === undefined) delete process.env.ADMIN_ACCESS_KEY; else process.env.ADMIN_ACCESS_KEY = previous.key;
    if (previous.org === undefined) delete process.env.ADMIN_ORGANIZATION_ID; else process.env.ADMIN_ORGANIZATION_ID = previous.org;
  }
});

test('production permits only configured origins and administration rejects anonymous writes', () => {
  const previous = { node: process.env.NODE_ENV, origin: process.env.FRONTEND_ORIGIN };
  try {
    process.env.NODE_ENV = 'production'; process.env.FRONTEND_ORIGIN = 'https://bilhetou.vercel.app';
    assert.deepEqual(allowedOrigins(), ['https://bilhetou.vercel.app']);
    const context = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) };
    assert.throws(() => new AdminAuth(new AdminSessionStore()).canActivate(context));
  } finally {
    if (previous.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.node;
    if (previous.origin === undefined) delete process.env.FRONTEND_ORIGIN; else process.env.FRONTEND_ORIGIN = previous.origin;
  }
});

test('PostgreSQL + HTTP: validation, atomic creation, replay, concurrent conflict and pagination', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  // Only run against an explicitly designated disposable test database.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.NODE_ENV = 'test';
  const { NestFactory } = require('@nestjs/core');
  const { ValidationPipe } = require('@nestjs/common');
  const { AppModule } = require('../dist/app.module');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '512kb' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const prisma = app.get(PrismaService);
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api/admin`;
  let cookie = '';
  const request = async (path, body) => {
    const response = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) } : { headers: { Cookie: cookie } });
    if (path === '/session' && response.ok) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.json() };
  };
  let organization;
  try {
    organization = await prisma.organization.create({ data: { name: `Ticket tests ${randomUUID()}` } });
    const campaign = await prisma.campaign.create({ data: { ticketPriceCents: 250, organizationId: organization.id, name: 'Bilhetou TEST', rulesVersion: 'v1', status: 'OPEN' } });
    const other = await prisma.campaign.create({ data: { ticketPriceCents: 250, organizationId: organization.id, name: 'Not enabled', rulesVersion: 'v1', legacySample: true, status: 'ARCHIVED' } });
    process.env.ADMIN_ORGANIZATION_ID = organization.id; process.env.ADMIN_ACCESS_KEY = 'a'.repeat(40);
    assert.equal((await request('/session', { secret: process.env.ADMIN_ACCESS_KEY })).status, 201);
    const input = { campaignId: campaign.id, quantity: 3, prefix: 'BIL', uniqueNumbers: true };
    assert.equal((await request('/ticket-batches/preview', { ...input, quantity: 0 })).status, 400);
    assert.equal((await request('/ticket-batches/preview', { ...input, admin: true })).status, 400);
    assert.equal((await request('/ticket-batches/preview', { ...input, campaignId: other.id })).status, 404);
    const preview = await request('/ticket-batches/preview', input);
    assert.equal(preview.status, 201);
    assert.equal(await prisma.ticket.count({ where: { campaignId: campaign.id } }), 0);
    assert.equal((await request('/ticket-batches/confirm', { token: preview.body.token + 'tampered' })).status, 400);
    const confirmed = await Promise.all([request('/ticket-batches/confirm', { token: preview.body.token }), request('/ticket-batches/confirm', { token: preview.body.token })]);
    assert.ok(confirmed.every(result => result.status === 201));
    assert.equal(confirmed.filter(result => result.body.replayed).length, 1);
    assert.equal(await prisma.ticket.count({ where: { campaignId: campaign.id } }), 3);
    assert.equal(await prisma.ticketNumber.count({ where: { ticket: { campaignId: campaign.id } } }), 12);

    const [a, b] = await Promise.all([request('/ticket-batches/preview', { ...input, quantity: 1 }), request('/ticket-batches/preview', { ...input, quantity: 1 })]);
    const competing = await Promise.all([request('/ticket-batches/confirm', { token: a.body.token }), request('/ticket-batches/confirm', { token: b.body.token })]);
    assert.deepEqual(competing.map(result => result.status).sort(), [201, 409]);
    assert.equal(await prisma.ticket.count({ where: { campaignId: campaign.id } }), 4);
    assert.equal(await prisma.ticketNumber.count({ where: { ticket: { campaignId: campaign.id } } }), 16);

    const big = await request('/ticket-batches/preview', { ...input, prefix: 'BIG', quantity: 2496, uniqueNumbers: false });
    assert.equal(big.status, 201);
    assert.ok(big.body.token.length > 100000);
    assert.equal((await request('/ticket-batches/confirm', { token: big.body.token })).status, 201);
    const page = await request(`/campaigns/${campaign.id}/tickets?page=2`);
    assert.equal(page.status, 200);
    assert.equal(page.body.items.length, 20);
    assert.equal(page.body.total, 2500);
    assert.equal((await request('/ticket-batches/preview', { ...input, quantity: 1 })).status, 409);
    const search = await request(`/campaigns/${campaign.id}/tickets?query=BIL-000001`);
    assert.equal(search.body.total, 1);
    const list = await request('/campaigns');
    assert.ok(list.body.some(item => item.id === campaign.id));
    assert.ok(!list.body.some(item => item.id === other.id));
  } finally {
    if (organization) {
      const campaigns = await prisma.campaign.findMany({ where: { organizationId: organization.id }, select: { id: true } });
      const ids = campaigns.map(item => item.id);
      await prisma.ticket.deleteMany({ where: { campaignId: { in: ids } } });
      await prisma.campaign.deleteMany({ where: { organizationId: organization.id } });
      await prisma.organization.delete({ where: { id: organization.id } });
    }
    await app.close();
  }
});
