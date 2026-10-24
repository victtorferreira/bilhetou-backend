const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const { PixPaymentService, pixConfiguration, abacatepayWebhookPublicKey } = require('../dist/payments/pix-payment.service');

const organizationId = randomUUID();
const provider = extra => ({ id: 'pix_char_real1', amount: 200, devMode: false, status: 'PENDING', brCode: '000201-pix-code', expiresAt: '2030-01-01T10:00:00Z', ...extra });
const response = data => Response.json({ success: true, error: null, data });
const input = () => ({ requestKey: randomUUID(), description: 'Produto de teste', amountCents: 200 });

function database() {
  const rows = new Map();
  const events = new Map();
  const matches = (row, where) => Object.entries(where).every(([key, value]) => value && typeof value === 'object' && 'in' in value ? value.in.includes(row[key]) : row[key] === value);
  return { rows, events, pixPayment: {
    async create({ data }) {
      if ([...rows.values()].some(row => row.organizationId === data.organizationId && row.requestKey === data.requestKey)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      const row = { id: randomUUID(), status: 'CREATING', providerId: null, brCode: null, expiresAt: null, paidAt: null, lastError: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.set(row.id, row); return { ...row };
    },
    async findUnique({ where }) { return [...rows.values()].find(row => matches(row, where.organizationId_requestKey)) ?? null; },
    async findFirst({ where }) { const row = [...rows.values()].find(row => matches(row, where)); return row ? { ...row } : null; },
    async findMany({ where }) { return [...rows.values()].filter(row => matches(row, where)).map(row => ({ ...row })); },
    async update({ where, data }) { const row = rows.get(where.id); Object.assign(row, data); return { ...row }; },
    async updateMany({ where, data }) { let count = 0; for (const row of rows.values()) if (matches(row, where)) { Object.assign(row, data); count++; } return { count }; },
  }, paymentWebhookEvent: {
    async findUnique({ where }) { return events.get(where.id) ?? null; },
    async upsert({ create }) { events.set(create.id, create); return create; },
  } };
}

async function withPayments(mock, run) {
  const names = ['ABACATEPAY_ENABLED', 'ABACATEPAY_ENVIRONMENT', 'ABACATEPAY_API_KEY', 'ABACATEPAY_WEBHOOK_SECRET'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const original = global.fetch;
  process.env.ABACATEPAY_ENABLED = 'true'; process.env.ABACATEPAY_ENVIRONMENT = 'production';
  process.env.ABACATEPAY_API_KEY = 'abc_prod_private_test'; process.env.ABACATEPAY_WEBHOOK_SECRET = 's'.repeat(64);
  global.fetch = mock;
  const db = database();
  try { await run(new PixPaymentService(db), db); }
  finally {
    global.fetch = original;
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
}

test('production and sandbox credentials must match environment and webhook secret is mandatory', async () => {
  await withPayments(() => assert.fail('no network'), async service => {
    assert.equal(pixConfiguration().devMode, false);
    process.env.ABACATEPAY_API_KEY = 'abc_dev_test';
    assert.throws(pixConfiguration, /ambiente/);
    process.env.ABACATEPAY_ENVIRONMENT = 'sandbox';
    assert.equal(pixConfiguration().devMode, true);
    process.env.ABACATEPAY_WEBHOOK_SECRET = '';
    assert.throws(pixConfiguration, /32 caracteres/);
    process.env.ABACATEPAY_ENABLED = 'false';
    assert.throws(() => service.configuration(), /desativadas/);
  });
});

test('concurrent requests with the same key create one persisted real charge and changed data conflicts', async () => {
  let calls = 0;
  await withPayments(async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.abacatepay.com/v2/transparents/create');
    assert.equal(init.headers.Authorization, 'Bearer abc_prod_private_test');
    const body = JSON.parse(init.body);
    assert.equal(body.data.amount, 200); assert.equal(body.data.description, 'Produto de teste');
    assert.match(body.data.externalId, /^[\da-f-]{36}$/);
    return response(provider());
  }, async (service, db) => {
    const request = input();
    const [a, b] = await Promise.all([service.create(organizationId, request), service.create(organizationId, request)]);
    assert.equal(a.id, b.id); assert.equal(db.rows.size, 1); assert.equal(calls, 1);
    assert.equal((await service.create(organizationId, request)).status, 'PENDING');
    assert.equal(calls, 1);
    await assert.rejects(service.create(organizationId, { ...request, amountCents: 500 }), /outros dados/);
  });
});

test('uncertain creation is persisted and retry with same key never repeats provider POST', async () => {
  let calls = 0;
  await withPayments(async () => { calls++; throw new Error('secret private network details'); }, async service => {
    const request = input();
    const a = await service.create(organizationId, request);
    const b = await service.create(organizationId, request);
    assert.equal(a.id, b.id); assert.equal(b.status, 'UNKNOWN'); assert.equal(calls, 1);
    assert.ok(!a.lastError.includes('private'));
  });
});

test('mismatched amount, sandbox response or malformed charge cannot become a usable real payment', async () => {
  for (const overrides of [{ amount: 201 }, { devMode: true }, { id: 'card_other' }, { brCode: '' }, { status: 'OTHER' }]) {
    await withPayments(async () => response(provider(overrides)), async service => {
      const row = await service.create(organizationId, input());
      assert.equal(row.status, 'UNKNOWN'); assert.equal(row.brCode, null);
    });
  }
});

test('organization isolation and environment checks precede any provider lookup', async () => {
  await withPayments(async () => response(provider()), async service => {
    const row = await service.create(organizationId, input());
    global.fetch = () => assert.fail('must not query provider');
    await assert.rejects(service.get(randomUUID(), row.id), /não encontrada/);
    await assert.rejects(service.check(randomUUID(), row.id), /não encontrada/);
    process.env.ABACATEPAY_ENVIRONMENT = 'sandbox'; process.env.ABACATEPAY_API_KEY = 'abc_dev_test';
    await assert.rejects(service.check(organizationId, row.id), /mesmo ambiente/);
  });
});

test('API confirms status and late pending/expired responses never downgrade PAID', async () => {
  let state = 'PAID';
  await withPayments(async url => response(url.endsWith('/create') ? provider() : { id: 'pix_char_real1', status: state }), async service => {
    const row = await service.create(organizationId, input());
    assert.equal((await service.check(organizationId, row.id)).status, 'PAID');
    state = 'PENDING'; assert.equal((await service.check(organizationId, row.id)).status, 'PAID');
    state = 'EXPIRED'; assert.equal((await service.check(organizationId, row.id)).status, 'PAID');
    global.fetch = async () => response({ id: 'pix_char_other', status: 'PAID' });
    await assert.rejects(service.check(organizationId, row.id), /MISMATCH/);
  });
});

test('webhooks require private secret and raw-body signature, reconcile via API, and deduplicate event IDs', async () => {
  let polls = 0;
  await withPayments(async url => {
    if (url.endsWith('/create')) return response(provider());
    polls++; return response({ id: 'pix_char_real1', status: 'PAID' });
  }, async (service, db) => {
    const row = await service.create(organizationId, input());
    const event = { id: 'log_1', event: 'transparent.completed', devMode: false, data: { payment: { id: 'pix_char_real1', status: 'PAID', amount: 1 } } };
    const raw = Buffer.from(JSON.stringify(event));
    const signature = createHmac('sha256', abacatepayWebhookPublicKey).update(raw).digest('base64');
    const secret = process.env.ABACATEPAY_WEBHOOK_SECRET;
    await assert.rejects(service.webhook('wrong-secret', signature, raw, event), /não autorizado/);
    await assert.rejects(service.webhook(secret, 'invalid', raw, event), /Assinatura/);
    await assert.rejects(service.webhook(secret, signature, Buffer.from('{}'), event), /Assinatura/);
    assert.equal(polls, 0);
    assert.deepEqual(await service.webhook(secret, signature, raw, event), { received: true });
    assert.equal(db.rows.get(row.id).status, 'PAID'); assert.equal(polls, 1);
    assert.deepEqual(await service.webhook(secret, signature, raw, event), { received: true });
    assert.equal(polls, 1); assert.equal(db.events.size, 1);
  });
});

test('webhook retries if source API is not paid yet; simulated events cannot confirm production charges', async () => {
  await withPayments(async url => response(url.endsWith('/create') ? provider() : { id: 'pix_char_real1', status: 'PENDING' }), async (service, db) => {
    const row = await service.create(organizationId, input());
    const event = { id: 'log_pending', event: 'transparent.completed', devMode: false, data: { id: 'pix_char_real1' } };
    const call = body => { const raw = Buffer.from(JSON.stringify(body)); return service.webhook(process.env.ABACATEPAY_WEBHOOK_SECRET, createHmac('sha256', abacatepayWebhookPublicKey).update(raw).digest('base64'), raw, body); };
    await assert.rejects(call(event), /ainda não confirmado/);
    assert.equal(db.events.size, 0); assert.equal(db.rows.get(row.id).status, 'PENDING');
    await assert.rejects(call({ ...event, devMode: true }), /ambiente inválido/);
  });
});

test('HTTP production charges require admin, JSON, validated values and raw webhook authentication', async () => {
  require('reflect-metadata');
  const { Module, ValidationPipe } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { AdminAuth, AdminSessionStore } = require('../dist/tickets/admin-auth');
  const { PixPaymentController, PixPaymentWebhookController } = require('../dist/payments/pix-payment.controller');
  const store = new AdminSessionStore();
  store.sessions.set('admin-token', { organizationId, actor: 'test', expires: Date.now() + 60000 });
  let receivedRaw = false;
  class TestModule {}
  Module({ controllers: [PixPaymentController, PixPaymentWebhookController], providers: [AdminAuth, { provide: AdminSessionStore, useValue: store }, { provide: PixPaymentService, useValue: {
    create: async (org, dto) => { assert.equal(org, organizationId); return dto; },
    webhook: async (_, __, raw) => { receivedRaw = Buffer.isBuffer(raw); return { received: true }; },
  } }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false, rawBody: true });
  app.setGlobalPrefix('api'); app.useBodyParser('json', { limit: '512kb' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  try {
    const url = `${await app.getUrl()}/api/admin/payments/pix`;
    const headers = { Cookie: 'bilhetou_admin=admin-token', 'content-type': 'application/json' };
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input()) })).status, 401);
    for (const amountCents of [0, 99, 1.5, 1000001, '200']) assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...input(), amountCents }) })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(input()) })).status, 201);
    await fetch(`${await app.getUrl()}/api/payments/abacatepay/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"log_1"}' });
    assert.equal(receivedRaw, true);
  } finally { await app.close(); }
});

test('PostgreSQL: real unique claim prevents duplicate provider requests and survives service recreation', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { PrismaClient } = require('../dist/generated/prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
  const org = await prisma.organization.create({ data: { name: 'PIX INTEGRATION TEST' } });
  try {
    let posts = 0;
    await withPayments(async () => { posts++; return response(provider({ id: `pix_char_${randomUUID()}` })); }, async () => {
      const services = [new PixPaymentService(prisma), new PixPaymentService(prisma)];
      const request = input();
      const [a, b] = await Promise.all(services.map(service => service.create(org.id, request)));
      assert.equal(a.id, b.id); assert.equal(posts, 1);
      const resumed = await new PixPaymentService(prisma).create(org.id, request);
      assert.equal(resumed.status, 'PENDING'); assert.equal(posts, 1);
      assert.equal((await prisma.pixPayment.findMany({ where: { organizationId: org.id } })).length, 1);
      await assert.rejects(prisma.pixPayment.create({ data: { organizationId: org.id, requestKey: randomUUID(), environment: 'production', amountCents: 0, description: 'Invalid' } }));
    });
  } finally {
    await prisma.pixPayment.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.$disconnect();
  }
});
