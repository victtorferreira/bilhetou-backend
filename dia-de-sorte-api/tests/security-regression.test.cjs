const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { AdminAuth, AdminSessionStore } = require('../dist/tickets/admin-auth');
const { ParticipantService } = require('../dist/participants/participant.service');
const { RequestLimits } = require('../dist/security/request-limits');
const { configureHttpSecurity } = require('../dist/security/http-security');
const { expireReservations } = require('../dist/payments/reservations');

test('valid admin credential still works after failed attempts from a shared proxy', () => {
  const previous = { ADMIN_ACCESS_KEY: process.env.ADMIN_ACCESS_KEY, ADMIN_ORGANIZATION_ID: process.env.ADMIN_ORGANIZATION_ID };
  try {
    process.env.ADMIN_ACCESS_KEY = 'a'.repeat(40); process.env.ADMIN_ORGANIZATION_ID = randomUUID();
    const auth = new AdminAuth(new AdminSessionStore());
    for (let i = 0; i < 30; i++) assert.throws(() => auth.login('wrong-key', 'shared-proxy'));
    assert.match(auth.login(process.env.ADMIN_ACCESS_KEY, 'shared-proxy'), /^[a-f0-9]{64}$/);
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('paid campaign refuses a new order if the gateway is disabled; no stock is assigned', async () => {
  const previous = process.env.ZETTPAY_ENABLED;
  try {
    process.env.ZETTPAY_ENABLED = 'false';
    let assigned = false;
    const tx = { order: { findUnique: async () => null }, ticket: { updateMany: async () => { assigned = true; } } };
    const service = new ParticipantService({ $transaction: async cb => cb(tx) });
    const session = { id: randomUUID(), selectionKey: randomUUID(), selectedIds: [randomUUID()], participantId: randomUUID() };
    service.lockedSession = async () => session;
    service.campaign = async () => ({ id: randomUUID(), ticketPriceCents: 200 });
    await assert.rejects(service.confirm('mock', session.selectionKey), /desativado/);
    assert.equal(assigned, false);
  } finally { if (previous === undefined) delete process.env.ZETTPAY_ENABLED; else process.env.ZETTPAY_ENABLED = previous; }
});

test('expiration releases only unpaid expired reservations and preserves paid orders', async () => {
  const campaignId = randomUUID(), now = new Date();
  const orders = [
    { id: 'old', campaignId, paymentRequired: true, paymentStatus: 'UNPAID', reservationExpiresAt: new Date(0) },
    { id: 'paid', campaignId, paymentRequired: true, paymentStatus: 'PAID', reservationExpiresAt: new Date(0) },
    { id: 'live', campaignId, paymentRequired: true, paymentStatus: 'UNPAID', reservationExpiresAt: new Date(Date.now() + 60000) },
  ];
  const tickets = orders.map(order => ({ orderId: order.id, status: 'ASSIGNED' }));
  const matches = (order, where) => order.campaignId === where.campaignId && order.paymentRequired === where.paymentRequired && order.paymentStatus === where.paymentStatus && order.reservationExpiresAt <= where.reservationExpiresAt.lte;
  await expireReservations({
    ticket: { updateMany: async ({ where, data }) => { for (const ticket of tickets) if (matches(orders.find(o => o.id === ticket.orderId), where.order)) Object.assign(ticket, data); } },
    order: { updateMany: async ({ where, data }) => { for (const order of orders) if (matches(order, where)) Object.assign(order, data); } },
  }, campaignId, now);
  assert.deepEqual(tickets.map(ticket => ticket.status), ['AVAILABLE', 'ASSIGNED', 'ASSIGNED']);
  assert.equal(tickets[0].orderId, null);
  assert.deepEqual(orders.map(order => order.paymentStatus), ['EXPIRED', 'PAID', 'UNPAID']);
});

test('HTTP public lookups scope tenants, hide assigned tickets and unpublished draws', async () => {
  const { Module } = require('@nestjs/common'); const { NestFactory } = require('@nestjs/core');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const { TicketsController } = require('../dist/tickets/tickets.controller');
  const { DrawsController } = require('../dist/draws/draws.controller');
  const org = randomUUID(), foreignOrg = randomUUID(), campaignId = randomUUID();
  const previous = process.env.PUBLIC_ORGANIZATION_ID; process.env.PUBLIC_ORGANIZATION_ID = org;
  const fixtures = [
    { id: randomUUID(), status: 'AVAILABLE', campaign: { organizationId: org, legacySample: false, deletedAt: null, status: 'OPEN' } },
    { id: randomUUID(), status: 'ASSIGNED', campaign: { organizationId: org, legacySample: false, deletedAt: null, status: 'OPEN' } },
    { id: randomUUID(), status: 'AVAILABLE', campaign: { organizationId: foreignOrg, legacySample: false, deletedAt: null, status: 'OPEN' } },
    { id: randomUUID(), status: 'AVAILABLE', campaign: { organizationId: org, legacySample: false, deletedAt: new Date(), status: 'OPEN' } },
  ];
  class ReviewModule {}
  Module({ controllers: [TicketsController, DrawsController], providers: [{ provide: PrismaService, useValue: {
    ticket: { findFirst: async ({ where }) => fixtures.find(t => t.id === where.id && t.status === where.status && t.campaign.organizationId === where.campaign?.organizationId && !t.campaign.deletedAt && where.campaign.deletedAt === null && where.campaign.legacySample === false) || null },
    draw: { findMany: async ({ where, select, take }) => {
      assert.equal(where.campaign.organizationId, org); assert.equal(where.campaign.deletedAt, null); assert.equal(where.campaign.legacySample, false);
      assert.deepEqual(where.status.in, ['RECORDED', 'REVIEWED']); assert.equal(select._count, undefined); assert.equal(take, 100);
      return [];
    } },
  } }] })(ReviewModule);
  const app = await NestFactory.create(ReviewModule, { logger: false }); app.setGlobalPrefix('api');
  try {
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    for (const [index, item] of fixtures.entries()) assert.equal((await fetch(`${base}/api/tickets/${item.id}`)).status, index === 0 ? 200 : 404);
    assert.deepEqual(await (await fetch(`${base}/api/draws/${campaignId}`)).json(), []);
  } finally { await app.close(); if (previous === undefined) delete process.env.PUBLIC_ORGANIZATION_ID; else process.env.PUBLIC_ORGANIZATION_ID = previous; }
});

test('request limits share counters across guard instances without storing raw identities', async () => {
  const counters = new Map();
  const prisma = { $queryRaw: async (strings, key) => {
    assert.match(key, /^[a-f0-9]{64}$/); const count = (counters.get(key) || 0) + 1; counters.set(key, count); return [{ count }];
  } };
  const a = new RequestLimits(prisma), b = new RequestLimits(prisma);
  const result = await Promise.allSettled([a, b, a, b].map(guard => guard.consume('test', 'private-identity', 2, 60000)));
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(result.filter(r => r.status === 'rejected' && r.reason.getStatus() === 429).length, 2);
});

test('HTTP registration limits cover aliases, case variations and trailing slashes', async () => {
  const { Module } = require('@nestjs/common'); const { APP_GUARD, NestFactory } = require('@nestjs/core');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const { ParticipantController, ParticipantOriginGuard } = require('../dist/participants/participant.controller');
  const counters = new Map();
  const db = { $queryRaw: async (strings, key) => { const count = (counters.get(key) || 0) + 1; counters.set(key, count); return [{ count }]; } };
  class ReviewModule {}
  Module({ controllers: [ParticipantController], providers: [ParticipantOriginGuard, { provide: APP_GUARD, useClass: RequestLimits }, { provide: PrismaService, useValue: db }, { provide: ParticipantService, useValue: { token: () => undefined, register: async () => ({ token: 'test', state: {} }), cookie: () => 'test=1' } }] })(ReviewModule);
  const app = await NestFactory.create(ReviewModule, { logger: false }); app.setGlobalPrefix('api');
  try {
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    for (let i = 0; i < 11; i++) {
      const route = ['/api/participant/session', '/api/demo/session/', '/api/Participant/Session/'][i % 3];
      const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i}` }, body: JSON.stringify({ name: 'Maria Silva', phone: '98999999999' }) });
      assert.equal(response.status, i < 10 ? 201 : 429);
    }
  } finally { await app.close(); }
});

test('HTTP rejects compressed bodies, ignores spoofed proxy headers and applies browser protections', async () => {
  const { Module, Controller, Post, Get, Req } = require('@nestjs/common'); const { NestFactory } = require('@nestjs/core');
  class ControllerFixture { post() { return { ok: true }; } get(req) { return { ip: req.ip }; } }
  Controller('probe')(ControllerFixture);
  Post()(ControllerFixture.prototype, 'post', Object.getOwnPropertyDescriptor(ControllerFixture.prototype, 'post'));
  Get()(ControllerFixture.prototype, 'get', Object.getOwnPropertyDescriptor(ControllerFixture.prototype, 'get'));
  Req()(ControllerFixture.prototype, 'get', 0);
  class ReviewModule {} Module({ controllers: [ControllerFixture] })(ReviewModule);
  const previous = process.env.TRUSTED_PROXY_CIDRS; delete process.env.TRUSTED_PROXY_CIDRS;
  const app = await NestFactory.create(ReviewModule, { logger: false, rawBody: true });
  try {
    configureHttpSecurity(app); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const compressed = await fetch(`${base}/probe`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: require('node:zlib').gzipSync('{}') });
    assert.equal(compressed.status, 415);
    const next = await fetch(`${base}/probe`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    assert.equal(next.status, 200); assert.equal((await next.json()).ip, '127.0.0.1');
    assert.equal(next.headers.get('x-powered-by'), null); assert.equal(next.headers.get('x-content-type-options'), 'nosniff');
    assert.match(next.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  } finally { await app.close(); if (previous === undefined) delete process.env.TRUSTED_PROXY_CIDRS; else process.env.TRUSTED_PROXY_CIDRS = previous; }
});

test('PostgreSQL: expired stock is reused safely, late payment cannot steal it, and rate limits are atomic', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { PrismaClient } = require('../dist/generated/prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { ZettpayService } = require('../dist/payments/zettpay.service');
  const { ReservationCleanup } = require('../dist/payments/reservations');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
  const settings = { ZETTPAY_ENABLED: 'true', ZETTPAY_CLIENT_ID: 'test', ZETTPAY_CLIENT_SECRET: 'test-secret', ZETTPAY_WEBHOOK_SIGNING_SECRET: `whsec_${'x'.repeat(48)}`, ZETTPAY_PAID_STATUS: 'approved' };
  const previous = Object.fromEntries([...Object.keys(settings), 'PUBLIC_ORGANIZATION_ID', 'PUBLIC_CAMPAIGN_ID'].map(key => [key, process.env[key]]));
  const org = await prisma.organization.create({ data: { name: 'Security regression TEST' } });
  Object.assign(process.env, settings, { PUBLIC_ORGANIZATION_ID: org.id }); delete process.env.PUBLIC_CAMPAIGN_ID;
  let campaign;
  try {
    campaign = await prisma.campaign.create({ data: { organizationId: org.id, name: 'Security TEST', status: 'OPEN', ticketPriceCents: 200 } });
    async function createTicket(serial, values) {
      return prisma.$transaction(async tx => {
        const ticket = await tx.ticket.create({ data: { campaignId: campaign.id, serial } });
        await tx.ticketNumber.createMany({ data: values.map((value, i) => ({ ticketId: ticket.id, campaignId: campaign.id, position: i + 1, value })) });
        return ticket;
      });
    }
    const ticket = await createTicket('SEC-1', ['9100', '9101', '9102', '9103']);
    const secondTicket = await createTicket('SEC-2', ['9200', '9201', '9202', '9203']);
    const participants = new ParticipantService(prisma);
    const first = await participants.register('Maria Silva', '98999999999');
    const second = await participants.register('Maria Silva', '98999999999');
    const selected = await participants.select(first.token, { ticketIds: [ticket.id] });
    const firstState = await participants.confirm(first.token, selected.selectionKey);
    const firstOrder = firstState.orders[0];
    assert.equal(firstOrder.paymentRequired, true); assert.equal(firstOrder.tickets.length, 0);
    assert.ok(new Date(firstOrder.reservationExpiresAt) > new Date());
    assert.ok(new Date(firstOrder.reservationExpiresAt).getTime() <= Date.now() + 900000);
    const blocked = await participants.select(second.token, { ticketIds: [secondTicket.id] });
    await assert.rejects(participants.confirm(second.token, blocked.selectionKey), /pedido pendente/);

    const client = {
      create: async input => ({ id: input.id, external_id: input.id, status: 'pending', amount: '2.00', qr_code: '000201-security-test' }),
      lookup: async id => ({ id, external_id: id, status: 'approved', amount: '2.00' }),
    };
    const payments = new ZettpayService(prisma, participants, client);
    const payer = { payerEmail: 'test@example.com', payerDocument: '11144477735' };
    await payments.create(first.token, firstOrder.id, payer);
    await prisma.order.update({ where: { id: firstOrder.id }, data: { reservationExpiresAt: new Date(0) } });
    const reusedSelection = await participants.select(second.token, { ticketIds: [ticket.id] });
    const [late, reused] = await Promise.all([
      payments.check(first.token, firstOrder.id),
      participants.confirm(second.token, reusedSelection.selectionKey),
    ]);
    const newOrder = reused.orders[0];
    assert.equal(late.payment.status, 'PAID'); assert.equal(late.order.paymentStatus, 'REVIEW_REQUIRED');
    assert.equal((await prisma.ticket.findUnique({ where: { id: ticket.id } })).orderId, newOrder.id);
    await payments.create(second.token, newOrder.id, payer);
    const confirmed = await payments.check(second.token, newOrder.id);
    assert.equal(confirmed.order.paymentStatus, 'PAID');
    await prisma.order.update({ where: { id: newOrder.id }, data: { reservationExpiresAt: new Date(0) } });
    await new ReservationCleanup(prisma).sweep();
    assert.equal((await prisma.ticket.findUnique({ where: { id: ticket.id } })).orderId, newOrder.id);

    const scope = randomUUID();
    const guards = [new RequestLimits(prisma), new RequestLimits(prisma)];
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => guards[i % 2].consume(scope, 'same-client', 5, 60000)));
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 5);
    assert.equal(attempts.filter(r => r.status === 'rejected' && r.reason.getStatus() === 429).length, 15);
    const key = require('node:crypto').createHash('sha256').update(`${scope}\0same-client`).digest('hex');
    await prisma.requestLimit.update({ where: { key }, data: { expiresAt: new Date(0) } });
    await guards[0].consume(scope, 'same-client', 5, 60000);
    assert.equal((await prisma.requestLimit.findUnique({ where: { key } })).count, 1);
    await prisma.requestLimit.delete({ where: { key } });
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await prisma.participantSession.deleteMany({ where: { participant: { organizationId: org.id } } });
    if (campaign) {
      await prisma.zettpayPayment.deleteMany({ where: { order: { campaignId: campaign.id } } });
      await prisma.ticket.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.order.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.campaign.delete({ where: { id: campaign.id } });
    }
    await prisma.participant.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.$disconnect();
  }
});
