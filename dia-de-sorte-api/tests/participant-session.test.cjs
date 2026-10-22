const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { ParticipantService, normalizeRegistration } = require('../dist/demo/participant.service');
const { ParticipantOriginGuard, ParticipantController } = require('../dist/demo/participant.controller');
const { UnauthorizedException } = require('@nestjs/common');

test('registration validates identity fields on the server, preserving accents and rejecting invalid phones', () => {
  assert.deepEqual(normalizeRegistration('  João   da Silva ', '(98) 99999-9999'), { name: 'João da Silva', phone: '98999999999' });
  for (const name of ['João', '123 Silva', 'Maria '.repeat(40)]) assert.throws(() => normalizeRegistration(name, '98999999999'));
  for (const phone of ['20999999999','98899999999','9899999999']) assert.throws(() => normalizeRegistration('João Silva', phone));
});
test('anonymous refresh returns an empty usable state without needing a database or cookie', async () => {
  const state = await new ParticipantService({}).current();
  assert.equal(state.participant, null); assert.deepEqual(state.orders, []); assert.deepEqual(state.selectedIds, []);
});
test('session cookie is HttpOnly, scoped to demo paths, and secure in production', () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const service = new ParticipantService({});
    const token = 'a'.repeat(64);
    assert.equal(service.token(`other=1; bilhetou_participant=${token}`), token);
    assert.match(service.cookie(token), /HttpOnly; SameSite=Strict; Path=\/api\/demo/);
    assert.match(service.cookie(token), /; Secure$/);
    assert.match(service.cookie('', true), /Max-Age=0/);
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});
test('participant mutations reject untrusted origins and non-JSON bodies', () => {
  const previous = process.env.FRONTEND_ORIGIN;
  process.env.FRONTEND_ORIGIN = 'https://bilhetou.vercel.app';
  try {
    const guard = new ParticipantOriginGuard();
    const context = headers => ({ switchToHttp: () => ({ getRequest: () => ({ method: 'POST', headers }) }) });
    assert.equal(guard.canActivate(context({ origin: 'https://bilhetou.vercel.app', 'content-type': 'application/json' })), true);
    assert.throws(() => guard.canActivate(context({ origin: 'https://other.example', 'content-type': 'application/json' })));
    assert.throws(() => guard.canActivate(context({ 'content-type': 'text/plain' })));
  } finally { if (previous === undefined) delete process.env.FRONTEND_ORIGIN; else process.env.FRONTEND_ORIGIN = previous; }
});
test('expired sessions are cleared from view, and tickets reject unauthenticated callers', async () => {
  const service = new ParticipantService({ $transaction: async cb => cb({ participantSession: { findUnique: async () => ({ expiresAt: new Date(0), participant: { organizationId: 'ORG' } }) } }) });
  assert.equal((await service.current('a'.repeat(64))).participant, null);
  await assert.rejects(service.tickets(undefined, 1, '', false), UnauthorizedException);
});
test('session from another organization cannot retrieve participant results', async () => {
  const previous = process.env.DEMO_ORGANIZATION_ID;
  process.env.DEMO_ORGANIZATION_ID = 'ORG-A';
  try {
    const service = new ParticipantService({ participantSession: { findUnique: async () => ({ expiresAt: new Date(Date.now() + 60000), participant: { organizationId: 'ORG-B' } }) } });
    await assert.rejects(service.results('a'.repeat(64)), UnauthorizedException);
  } finally { if (previous === undefined) delete process.env.DEMO_ORGANIZATION_ID; else process.env.DEMO_ORGANIZATION_ID = previous; }
});
test('logout deletes only the current hashed token, never stores the bearer token', async () => {
  let where;
  const service = new ParticipantService({ participantSession: { deleteMany: async input => { where = input.where; } } });
  await service.logout('a'.repeat(64));
  assert.equal(where.tokenHash, createHash('sha256').update('a'.repeat(64)).digest('hex'));
  assert.notEqual(where.tokenHash, 'a'.repeat(64));
});
test('confirmation replay is scoped to participant and never assigns stock twice', async () => {
  const previous = process.env.DEMO_ORGANIZATION_ID;
  process.env.DEMO_ORGANIZATION_ID = 'ORG';
  try {
    const session = { id: randomUUID(), participantId: 'PERSON', participant: { id: 'PERSON', organizationId: 'ORG', name: 'Maria Silva', phone: '98999999999' }, expiresAt: new Date(Date.now() + 60000), campaignId: null, selectedIds: [], selectionKey: randomUUID() };
    const key = randomUUID();
    const tx = { $queryRaw: async () => [], participantSession: { findUnique: async () => session }, demoOrder: { findUnique: async ({ where }) => { assert.equal(where.participantId_idempotencyKey.participantId, 'PERSON'); assert.equal(where.participantId_idempotencyKey.idempotencyKey, key); return { id: 'ORDER' }; }, findMany: async () => [] } };
    const service = new ParticipantService({ $transaction: async cb => cb(tx) });
    const result = await service.confirm('a'.repeat(64), key);
    assert.equal(result.participant.id, 'PERSON');
  } finally { if (previous === undefined) delete process.env.DEMO_ORGANIZATION_ID; else process.env.DEMO_ORGANIZATION_ID = previous; }
});
test('HTTP exposes session routes and validates registration DTOs without touching a real database', async () => {
  const { Module, ValidationPipe } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  class TestModule {}
  Module({ controllers: [ParticipantController], providers: [ParticipantOriginGuard, { provide: ParticipantService, useValue: new ParticipantService({ $transaction: async cb => cb({}) }) }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  try {
    const base = await app.getUrl();
    const current = await fetch(`${base}/api/demo/session`);
    assert.equal(current.status, 200); assert.match(current.headers.get('cache-control'), /no-store/);
    assert.equal((await current.json()).participant, null);
    const invalid = await fetch(`${base}/api/demo/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Maria Silva', phone: '98999999999', admin: true }) });
    assert.equal(invalid.status, 400);
    assert.equal((await fetch(`${base}/api/demo/participant/tickets`)).status, 401);
  } finally { await app.close(); }
});

test('PostgreSQL: registration, scoped stock, concurrent confirmation replay and logout', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { PrismaClient } = require('../dist/generated/prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
  const service = new ParticipantService(prisma);
  const org = await prisma.organization.create({ data: { name: 'Participant TEST' } });
  const previous = { org: process.env.DEMO_ORGANIZATION_ID, campaign: process.env.PUBLIC_CAMPAIGN_ID };
  process.env.DEMO_ORGANIZATION_ID = org.id; delete process.env.PUBLIC_CAMPAIGN_ID;
  let campaign;
  try {
    campaign = await prisma.campaign.create({ data: { organizationId: org.id, name: 'Participant TEST', rulesVersion: 'demo-test', status: 'OPEN' } });
    await prisma.$transaction(async tx => {
      const t = await tx.ticket.create({ data: { campaignId: campaign.id, serial: 'TEST1' } });
      await tx.ticketNumber.createMany({ data: ['0038','1123','6789','9876'].map((value, i) => ({ ticketId: t.id, campaignId: campaign.id, value, position: i + 1 })) });
    });
    const a = await service.register('Maria Silva', '98999999999');
    const b = await service.register('Maria Silva', '98999999999');
    assert.notEqual(a.state.participant.id, b.state.participant.id);
    assert.equal((await service.current(a.token)).participant.id, a.state.participant.id);
    const page = await service.tickets(a.token, 1, '0038', false);
    assert.equal(page.total, 1); assert.equal(page.items[0].numbers[0], '0038');
    const selection = await service.select(a.token, { quantity: 1 });
    const result = await Promise.all([service.confirm(a.token, selection.selectionKey), service.confirm(a.token, selection.selectionKey)]);
    assert.equal(result[0].orders[0].id, result[1].orders[0].id);
    assert.equal((await service.current(b.token)).orders.length, 0);
    assert.equal(await prisma.demoOrder.count({ where: { participantId: a.state.participant.id } }), 1);
    await service.logout(a.token); assert.equal((await service.current(a.token)).participant, null);
  } finally {
    if (previous.org === undefined) delete process.env.DEMO_ORGANIZATION_ID; else process.env.DEMO_ORGANIZATION_ID = previous.org;
    if (previous.campaign === undefined) delete process.env.PUBLIC_CAMPAIGN_ID; else process.env.PUBLIC_CAMPAIGN_ID = previous.campaign;
    const participants = await prisma.demoParticipant.findMany({ where: { organizationId: org.id }, select: { id: true } });
    const ids = participants.map(p => p.id);
    await prisma.participantSession.deleteMany({ where: { participantId: { in: ids } } });
    if (campaign) {
      await prisma.ticket.updateMany({ where: { campaignId: campaign.id }, data: { status: 'AVAILABLE', assignedAt: null } });
      await prisma.ticket.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.demoOrder.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.campaign.delete({ where: { id: campaign.id } });
    }
    await prisma.demoParticipant.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.$disconnect();
  }
});
