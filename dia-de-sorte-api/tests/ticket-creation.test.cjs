const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { generateTickets } = require('../dist/tickets/ticket-generator');
const { LocalDemoGuard } = require('../dist/tickets/local-demo.guard');

test('generator validates quantities and serial prefixes', () => {
  const base = { quantity: 1, prefix: 'BIL', uniqueNumbers: false };
  for (const quantity of [0, -1, 1.2, 1001, NaN]) assert.throws(() => generateTickets({ ...base, quantity }, []));
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

test('local demo gate is disabled by default and always closed in production', () => {
  const previous = { enabled: process.env.ENABLE_LOCAL_DEMO_TICKET_CREATION, environment: process.env.NODE_ENV };
  const context = (ip = '127.0.0.1', origin = 'http://localhost:5173') => ({ switchToHttp: () => ({ getRequest: () => ({ method: 'POST', socket: { remoteAddress: ip }, headers: { origin, 'content-type': 'application/json' } }) }) });
  const guard = new LocalDemoGuard();
  try {
    delete process.env.ENABLE_LOCAL_DEMO_TICKET_CREATION;
    assert.throws(() => guard.canActivate(context()));
    process.env.ENABLE_LOCAL_DEMO_TICKET_CREATION = 'true';
    process.env.NODE_ENV = 'development';
    assert.equal(guard.canActivate(context()), true);
    assert.throws(() => guard.canActivate(context('192.168.1.2')));
    assert.throws(() => guard.canActivate(context('127.0.0.1', 'https://untrusted.example')));
    process.env.NODE_ENV = 'production';
    assert.throws(() => guard.canActivate(context()));
  } finally {
    for (const [key, value] of [['ENABLE_LOCAL_DEMO_TICKET_CREATION', previous.enabled], ['NODE_ENV', previous.environment]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('PostgreSQL + HTTP: validation, atomic creation, replay, concurrent conflict and pagination', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  // Only run against an explicitly designated disposable test database.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.ENABLE_LOCAL_DEMO_TICKET_CREATION = 'true';
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
  const base = `${await app.getUrl()}/api/demo/ticket-batches`;
  const request = async (path, body) => {
    const response = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: response.status, body: await response.json() };
  };
  let organization;
  try {
    organization = await prisma.organization.create({ data: { name: `Ticket tests ${randomUUID()}` } });
    const campaign = await prisma.campaign.create({ data: { organizationId: organization.id, name: 'Bilhetou TEST', rulesVersion: 'demo-v1', status: 'OPEN' } });
    const other = await prisma.campaign.create({ data: { organizationId: organization.id, name: 'Not enabled', rulesVersion: 'draft-v1' } });
    const input = { campaignId: campaign.id, quantity: 3, prefix: 'BIL', uniqueNumbers: true };
    assert.equal((await request('/preview', { ...input, quantity: 0 })).status, 400);
    assert.equal((await request('/preview', { ...input, admin: true })).status, 400);
    assert.equal((await request('/preview', { ...input, campaignId: other.id })).status, 409);
    const preview = await request('/preview', input);
    assert.equal(preview.status, 201);
    assert.equal(await prisma.ticket.count({ where: { campaignId: campaign.id } }), 0);
    assert.equal((await request('/confirm', { token: preview.body.token + 'tampered' })).status, 400);
    const confirmed = await Promise.all([request('/confirm', { token: preview.body.token }), request('/confirm', { token: preview.body.token })]);
    assert.ok(confirmed.every(result => result.status === 201));
    assert.equal(confirmed.filter(result => result.body.replayed).length, 1);
    assert.equal(await prisma.ticket.count({ where: { campaignId: campaign.id } }), 3);
    assert.equal(await prisma.ticketNumber.count({ where: { ticket: { campaignId: campaign.id } } }), 12);

    const [a, b] = await Promise.all([request('/preview', { ...input, quantity: 1 }), request('/preview', { ...input, quantity: 1 })]);
    const competing = await Promise.all([request('/confirm', { token: a.body.token }), request('/confirm', { token: b.body.token })]);
    assert.deepEqual(competing.map(result => result.status).sort(), [201, 409]);
    assert.equal(await prisma.ticket.count({ where: { campaignId: campaign.id } }), 4);
    assert.equal(await prisma.ticketNumber.count({ where: { ticket: { campaignId: campaign.id } } }), 16);

    const big = await request('/preview', { ...input, prefix: 'BIG', quantity: 1000, uniqueNumbers: false });
    assert.equal(big.status, 201);
    assert.ok(big.body.token.length > 100000);
    assert.equal((await request('/confirm', { token: big.body.token })).status, 201);
    const page = await request(`/campaigns/${campaign.id}/tickets?page=2`);
    assert.equal(page.status, 200);
    assert.equal(page.body.items.length, 20);
    assert.equal(page.body.total, 1004);
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
