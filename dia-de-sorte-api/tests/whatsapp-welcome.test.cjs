const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WhatsappWelcomeService, wahaConfig } = require('../dist/participants/whatsapp-welcome.service');
const { ParticipantService } = require('../dist/participants/participant.service');
const { RegisterParticipantDto } = require('../dist/participants/participant.dto');
const { validate } = require('class-validator');

function worker(row = {}) {
  const updates = [];
  let claimed = false;
  const prisma = {
    whatsappWelcome: { updateMany: async () => ({ count: 0 }), update: async value => { updates.push(value.data); } },
    $queryRaw: async () => {
      if (claimed) return [];
      claimed = true;
      return [{ id: 'welcome', attempts: 1, phone: '98999999999', name: 'Maria Silva', ...row }];
    },
  };
  const service = new WhatsappWelcomeService(prisma);
  service.config = { baseUrl: 'http://waha.test', apiKey: 'server-secret', session: 'default' };
  return { service, updates, prisma };
}

async function withFetch(mock, run) {
  const original = global.fetch;
  global.fetch = mock;
  try { await run(); } finally { global.fetch = original; }
}

test('worker authenticates, resolves Brazilian number and sends once using canonical LID', async () => {
  const { service, updates } = worker();
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.headers['X-Api-Key'], 'server-secret');
    if (url.includes('/sessions/')) return Response.json({ status: 'WORKING' });
    if (url.includes('/contacts/')) {
      assert.equal(new URL(url).searchParams.get('phone'), '5598999999999');
      return Response.json({ numberExists: true, chatId: '123456789@lid' });
    }
    const body = JSON.parse(init.body);
    assert.equal(body.chatId, '123456789@lid');
    assert.equal(body.session, 'default');
    assert.match(body.text, /Olá, Maria!/);
    return Response.json({ id: 'provider-message' });
  }, async () => { await service.processNext(); await service.processNext(); });
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
  assert.equal(updates.at(-1).status, 'SENT');
  assert.equal(updates.at(-1).providerMessageId, 'provider-message');
});

test('disconnected session retries without making a send request; retries are bounded', async () => {
  for (const attempts of [1, 10]) {
    const { service, updates } = worker({ attempts });
    await withFetch(async (_, init) => {
      assert.equal(init.method, 'GET');
      return Response.json({ status: 'SCAN_QR_CODE' });
    }, () => service.processNext());
    assert.equal(updates.at(-1).status, attempts === 1 ? 'PENDING' : 'FAILED');
    assert.equal(updates.at(-1).lastError, 'SESSION_NOT_WORKING');
    assert.ok(updates.at(-1).nextAttemptAt > new Date());
  }
});

test('contact lookup has a longer deadline while session checks and sending keep their deadlines', async () => {
  const { service, updates } = worker();
  const deadlines = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = ms => { deadlines.push(ms); return originalTimeout(ms); };
  try {
    await withFetch(async url => {
      if (url.includes('/sessions/')) return Response.json({ status: 'WORKING' });
      if (url.includes('/contacts/')) return Response.json({ numberExists: true, chatId: '123456789@lid' });
      return Response.json({ id: 'accepted' });
    }, () => service.processNext());
    assert.deepEqual(deadlines, [10000, 60000, 10000]);
    assert.equal(updates.at(-1).status, 'SENT');
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('pre-send failures record a safe diagnostic code and never send', async () => {
  for (const outcome of ['timeout', 'unauthorized', 'network']) {
    const { service, updates } = worker();
    await withFetch(async (url, init) => {
      assert.equal(init.method, 'GET');
      if (url.includes('/sessions/')) return Response.json({ status: 'WORKING' });
      if (outcome === 'unauthorized') return new Response('', { status: 401 });
      if (outcome === 'timeout') throw new DOMException('private request details', 'TimeoutError');
      throw new Error('private request details');
    }, () => service.processNext());
    assert.equal(updates.at(-1).status, 'PENDING');
    assert.equal(updates.at(-1).lastError, {
      timeout: 'CONTACT_TIMEOUT', unauthorized: 'CONTACT_HTTP_401', network: 'CONTACT_REQUEST_FAILED',
    }[outcome]);
  }
});

test('nonexistent WhatsApp number fails without attempting to send', async () => {
  const { service, updates } = worker();
  await withFetch(async (url, init) => {
    assert.equal(init.method, 'GET');
    return Response.json(url.includes('/sessions/') ? { status: 'WORKING' } : { numberExists: false });
  }, () => service.processNext());
  assert.equal(updates.at(-1).status, 'FAILED');
});

test('send timeout, server failure and missing acknowledgement remain UNKNOWN without automatic resend', async () => {
  for (const outcome of ['timeout', 'server-error', 'no-id']) {
    const { service, updates } = worker();
    let posts = 0;
    await withFetch(async (url, init) => {
      if (url.includes('/sessions/')) return Response.json({ status: 'WORKING' });
      if (url.includes('/contacts/')) return Response.json({ numberExists: true, chatId: '559899999999@c.us' });
      posts++;
      if (outcome === 'timeout') throw new Error('timeout');
      return outcome === 'server-error' ? new Response('', { status: 500 }) : Response.json({});
    }, async () => { await service.processNext(); await service.processNext(); });
    assert.equal(posts, 1);
    assert.equal(updates.at(-1).status, 'UNKNOWN');
  }
});

test('worker expires old pending welcomes and flags stale claims for manual reconciliation', async () => {
  const { service, prisma } = worker();
  const cleanups = [];
  prisma.whatsappWelcome.updateMany = async value => { cleanups.push(value); };
  prisma.$queryRaw = async () => [];
  await service.processNext();
  assert.equal(cleanups[0].where.status, 'PROCESSING');
  assert.equal(cleanups[0].data.status, 'UNKNOWN');
  assert.equal(cleanups[1].where.status, 'PENDING');
  assert.equal(cleanups[1].data.status, 'EXPIRED');
});

test('disabled worker makes no database or network calls', async () => {
  await new WhatsappWelcomeService({}).processNext();
});

test('configuration is disabled by default and rejects enabled mode without a key', () => {
  const previous = { ...process.env };
  try {
    delete process.env.WAHA_ENABLED;
    assert.equal(wahaConfig(), null);
    process.env.WAHA_ENABLED = 'true';
    process.env.WAHA_BASE_URL = 'http://localhost:3001';
    delete process.env.WAHA_API_KEY;
    assert.throws(wahaConfig, /WAHA_API_KEY/);
    process.env.WAHA_API_KEY = 'secret';
    assert.equal(wahaConfig().session, process.env.WAHA_SESSION?.trim() || 'default');
  } finally {
    for (const key of ['WAHA_ENABLED', 'WAHA_BASE_URL', 'WAHA_API_KEY']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test('consent is an optional strict boolean, never a truthy string', async () => {
  for (const value of [undefined, false, true, 'true', 1]) {
    const dto = Object.assign(new RegisterParticipantDto(), { name: 'Maria Silva', phone: '98999999999', whatsappConsent: value });
    assert.equal((await validate(dto)).length === 0, [undefined, false, true].includes(value));
  }
});

test('registration enqueues only with explicit consent in its transaction and preserves identity boundaries', async () => {
  const previous = process.env.PUBLIC_ORGANIZATION_ID;
  process.env.PUBLIC_ORGANIZATION_ID = 'ORG';
  try {
    for (const consent of [undefined, false, true]) {
      const queued = [];
      const tx = {
        organization: { findUnique: async () => ({ id: 'ORG' }) },
        campaign: { findFirst: async () => ({ id: 'CAMPAIGN' }) },
        participant: { create: async () => ({ id: 'NEW-PARTICIPANT' }) },
        whatsappWelcome: { createMany: async input => { queued.push(input); } },
        participantSession: { create: async () => ({}) },
      };
      const service = new ParticipantService({ $transaction: async cb => cb(tx) });
      service.snapshot = async () => ({ participant: { id: 'NEW-PARTICIPANT', verification: 'unverified' } });
      const result = await service.register('Maria Silva', '98999999999', undefined, consent);
      assert.equal(result.state.participant.verification, 'unverified');
      assert.equal(queued.length, consent === true ? 1 : 0);
      if (consent) {
        assert.equal(queued[0].skipDuplicates, true);
        assert.equal(queued[0].data[0].participantId, 'NEW-PARTICIPANT');
        assert.equal(queued[0].data[0].consentVersion, 'welcome-v1');
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_ORGANIZATION_ID; else process.env.PUBLIC_ORGANIZATION_ID = previous;
  }
});

test('PostgreSQL: repeated registration queues once and concurrent workers claim once', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { PrismaClient } = require('../dist/generated/prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
  const org = await prisma.organization.create({ data: { name: 'WAHA TEST' } });
  const previous = { org: process.env.PUBLIC_ORGANIZATION_ID, campaign: process.env.PUBLIC_CAMPAIGN_ID };
  process.env.PUBLIC_ORGANIZATION_ID = org.id;
  delete process.env.PUBLIC_CAMPAIGN_ID;
  try {
    await prisma.campaign.create({ data: { name: 'WAHA TEST', organizationId: org.id, ticketPriceCents: 100, status: 'OPEN' } });
    const registrations = new ParticipantService(prisma);
    const a = await registrations.register('Maria Silva', '98999999999', undefined, true);
    const b = await registrations.register('Maria Silva', '98999999999', undefined, true);
    assert.notEqual(a.state.participant.id, b.state.participant.id);
    assert.equal(await prisma.whatsappWelcome.count({ where: { organizationId: org.id } }), 1);
    let posts = 0;
    const workers = [new WhatsappWelcomeService(prisma), new WhatsappWelcomeService(prisma)];
    workers.forEach(service => { service.config = { baseUrl: 'http://waha.test', apiKey: 'secret', session: 'default' }; });
    await withFetch(async (url, init) => {
      if (url.includes('/sessions/')) return Response.json({ status: 'WORKING' });
      if (url.includes('/contacts/')) return Response.json({ numberExists: true, chatId: '5598999999999@c.us' });
      posts++;
      return Response.json({ id: 'accepted' });
    }, () => Promise.all(workers.map(service => service.processNext())));
    assert.equal(posts, 1);
    assert.equal((await prisma.whatsappWelcome.findFirst({ where: { organizationId: org.id } })).status, 'SENT');
  } finally {
    if (previous.org === undefined) delete process.env.PUBLIC_ORGANIZATION_ID; else process.env.PUBLIC_ORGANIZATION_ID = previous.org;
    if (previous.campaign === undefined) delete process.env.PUBLIC_CAMPAIGN_ID; else process.env.PUBLIC_CAMPAIGN_ID = previous.campaign;
    await prisma.participantSession.deleteMany({ where: { participant: { organizationId: org.id } } });
    await prisma.participant.deleteMany({ where: { organizationId: org.id } });
    await prisma.campaign.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.$disconnect();
  }
});
