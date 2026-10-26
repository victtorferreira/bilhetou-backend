const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { UnauthorizedException } = require('@nestjs/common');
const { ZettpayClient, zettpayConfiguration, reaisToCents, validPayerDocument, verifyZettpaySignature } = require('../dist/payments/zettpay.client');
const { ZettpayService } = require('../dist/payments/zettpay.service');

async function configured(run) {
  const values = { ZETTPAY_ENABLED: 'true', ZETTPAY_CLIENT_ID: 'test-client', ZETTPAY_CLIENT_SECRET: 'private-client-secret', ZETTPAY_WEBHOOK_SIGNING_SECRET: `whsec_${'a'.repeat(48)}`, ZETTPAY_PAID_STATUS: 'approved' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const fetch = global.fetch;
  Object.assign(process.env, values);
  try { await run(); } finally {
    global.fetch = fetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
const payer = { payerEmail: 'test@example.com', payerDocument: '11144477735' };
function fixture() {
  const order = { id: randomUUID(), campaignId: randomUUID(), participantId: randomUUID(), totalCents: 200, quantity: 1, paymentRequired: true, paymentStatus: 'UNPAID', reservationExpiresAt: new Date(Date.now() + 900000) };
  const payments = new Map(); const events = new Map();
  let posts = 0; let lookups = 0; let status = 'pending'; let missing = false;
  const transaction = payment => ({ id: 33, status, amount: '2.00', external_id: payment.id, currency: 'BRL', qr_code: '000201-test-pix' });
  const db = {
    order: {
      findFirst: async ({ where }) => where.id === order.id && where.participantId === order.participantId ? { ...order } : null,
      findUniqueOrThrow: async () => ({ ...order }),
      updateMany: async ({ where, data }) => { if (order.paymentStatus === where.paymentStatus && order.reservationExpiresAt <= where.reservationExpiresAt.lte) { Object.assign(order, data); return { count: 1 }; } return { count: 0 }; },
      update: async ({ data }) => Object.assign(order, data),
    },
    ticket: { updateMany: async () => ({ count: 0 }) },
    zettpayPayment: {
      create: async ({ data }) => {
        if (payments.size) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        const row = { id: randomUUID(), ...data, status: 'CREATING', providerId: null, lookupProviderId: null, qrCode: null, paidAt: null, providerStatus: null, lastError: null };
        payments.set(row.id, row); return { ...row };
      },
      findUnique: async ({ where }) => { const row = where.id ? payments.get(where.id) : [...payments.values()].find(row => row.orderId === where.orderId); return row ? { ...row } : null; },
      findUniqueOrThrow: async ({ where }) => ({ ...payments.get(where.id) }),
      update: async ({ where, data }) => Object.assign(payments.get(where.id), data),
      updateMany: async ({ where, data }) => { const row = payments.get(where.id); if (row && row.status !== where.status.not) Object.assign(row, data); return { count: 1 }; },
    },
    paymentWebhookEvent: { findUnique: async ({ where }) => events.get(where.id), upsert: async ({ create }) => { events.set(create.id, create); return create; } },
    $queryRaw: async () => [],
    $transaction: async cb => cb(db),
  };
  const participants = { paymentIdentity: async token => { if (token !== 'my-session') throw new UnauthorizedException(); return { id: order.participantId, organizationId: randomUUID(), name: 'Maria Silva' }; } };
  const client = {
    create: async input => { posts++; return transaction({ id: input.id }); },
    lookup: async id => { lookups++; return missing ? null : transaction({ id }); },
  };
  return { service: new ZettpayService(db, participants, client), db, client, order, payments, events, posts: () => posts, lookups: () => lookups, setStatus: value => { status = value; }, setMissing: () => { missing = true; } };
}

test('Zettpay money conversion uses reais and rejects ambiguous rounding; payer documents validate check digits', () => {
  assert.equal(reaisToCents('150.00'), 15000); assert.equal(reaisToCents(1), 100); assert.equal(reaisToCents('2.5'), 250);
  for (const value of ['2.005', '2,00', 'NaN', null, -1, {}, '1e3']) assert.equal(reaisToCents(value), null);
  assert.equal(validPayerDocument('111.444.777-35'), true);
  assert.equal(validPayerDocument('11.222.333/0001-81'), true);
  for (const value of ['11111111111', '11144477736', '123', '11222333000182']) assert.equal(validPayerDocument(value), false);
});

test('cash-in paid status must be explicitly configured and cannot be processing/pending', async () => configured(async () => {
  for (const value of ['', 'pending', 'processing', 'FAILED']) { process.env.ZETTPAY_PAID_STATUS = value; assert.throws(zettpayConfiguration, /cash-in pago/); }
  process.env.ZETTPAY_PAID_STATUS = 'approved'; assert.equal(zettpayConfiguration().paidStatus, 'approved');
  process.env.ZETTPAY_ENABLED = 'false'; assert.throws(zettpayConfiguration, /desativado/);
}));

test('participant session hides all priced unpaid tickets even when the gateway was disabled', async () => {
  const { ParticipantService } = require('../dist/participants/participant.service');
  const organizationId = randomUUID(); const campaignId = randomUUID(); const participantId = randomUUID();
  const previous = process.env.PUBLIC_ORGANIZATION_ID;
  process.env.PUBLIC_ORGANIZATION_ID = organizationId;
  const campaign = { id: campaignId, name: 'Campaign', status: 'OPEN', closesAt: null, ticketPriceCents: 200 };
  const ticket = { id: randomUUID(), campaignId, serial: 'T-1', status: 'ASSIGNED', numbers: [{ value: '0001' }], assignedAt: new Date() };
  const orders = [
    { paymentRequired: true, paymentStatus: 'UNPAID' },
    { paymentRequired: true, paymentStatus: 'PAID' },
    { paymentRequired: false, paymentStatus: 'UNPAID' },
  ].map(input => ({ id: randomUUID(), participantId, campaignId, totalCents: 200, quantity: 1, createdAt: new Date(), tickets: [ticket], campaign, ...input }));
  const tx = {
    participantSession: { findUnique: async () => ({ id: randomUUID(), participantId, campaignId, expiresAt: new Date(Date.now() + 60000), participant: { id: participantId, organizationId, name: 'Maria Silva', phone: '98999999999' }, selectedIds: [] }) },
    campaign: { findFirst: async () => campaign }, ticket: { count: async () => 0, findMany: async () => [] }, order: { findMany: async () => orders },
  };
  try {
    const service = new ParticipantService({ $transaction: async cb => cb(tx) });
    const state = await service.current('a'.repeat(64));
    assert.deepEqual(state.orders.map(order => order.tickets.length), [0, 1, 0]);
    assert.deepEqual(state.orders.map(order => order.ticketIds.length), [0, 1, 0]);
  } finally { if (previous === undefined) delete process.env.PUBLIC_ORGANIZATION_ID; else process.env.PUBLIC_ORGANIZATION_ID = previous; }
});

test('OAuth is single-flight and creation uses Idempotency-Key and reais, never exposes credentials in transaction body', async () => configured(async () => {
  let authentications = 0; let creates = 0;
  global.fetch = async (url, init) => {
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/oauth/token')) {
      authentications++; assert.deepEqual(JSON.parse(init.body), { client_id: 'test-client', client_secret: 'private-client-secret' });
      return Response.json({ access_token: 'private-access-token', token_type: 'Bearer', expires_in: 3600 });
    }
    creates++; assert.equal(url, 'https://api.zettpay.io/api/transactions');
    assert.equal(init.headers.Authorization, 'Bearer private-access-token');
    assert.equal(init.headers['Idempotency-Key'], 'bilhetou-charge-id');
    const body = JSON.parse(init.body); assert.equal(body.amount, 2); assert.equal(body.external_id, 'charge-id'); assert.equal(body.payer_document, payer.payerDocument);
    assert.ok(!init.body.includes('private-client-secret'));
    return Response.json({ id: 33, status: 'pending', qr_code: '000201-test' });
  };
  const client = new ZettpayClient();
  const input = { id: 'charge-id', orderId: 'order', amountCents: 200, payerName: 'Maria Silva', ...{ payerEmail: payer.payerEmail, payerDocument: payer.payerDocument } };
  await Promise.all([client.create(input), client.create(input)]);
  assert.equal(authentications, 1); assert.equal(creates, 2);
}));

test('OAuth refreshes once on 401 and lookup supports recovery by external_id; failures do not disclose provider body', async () => configured(async () => {
  let auth = 0; let lookups = 0;
  global.fetch = async url => {
    if (url.endsWith('/oauth/token')) { auth++; return Response.json({ access_token: `token-${auth}`, token_type: 'Bearer' }); }
    lookups++; assert.equal(new URL(url).searchParams.get('external_id'), 'local-id');
    return lookups === 1 ? new Response('', { status: 401 }) : Response.json({ data: { id: 33 }, success: true });
  };
  const client = new ZettpayClient(); assert.equal((await client.lookup('local-id')).id, 33); assert.equal(auth, 2);
  global.fetch = async () => new Response('private payer data', { status: 500 });
  await assert.rejects(client.lookup('local-id'), error => !error.message.includes('private payer'));
}));

test('checkout enforces session/order ownership, minimum value and valid payer details before creating a charge', async () => configured(async () => {
  const f = fixture();
  await assert.rejects(f.service.current('other-session', f.order.id), UnauthorizedException);
  await assert.rejects(f.service.create('my-session', randomUUID(), payer), /não encontrado/);
  await assert.rejects(f.service.create('my-session', f.order.id, { ...payer, payerDocument: '11111111111' }), /CPF/);
  f.order.totalCents = 99;
  await assert.rejects(f.service.create('my-session', f.order.id, payer), /mínimo/);
  assert.equal(f.posts(), 0); assert.equal(f.payments.size, 0);
}));

test('concurrent/repeated checkout makes one charge and does not release unpaid tickets', async () => configured(async () => {
  const f = fixture();
  const results = await Promise.all([f.service.create('my-session', f.order.id, payer), f.service.create('my-session', f.order.id, payer)]);
  assert.equal(f.posts(), 1); assert.equal(f.payments.size, 1);
  assert.equal(f.order.paymentStatus, 'UNPAID'); assert.equal(results[0].payment.amountCents, 200);
  assert.equal(results[0].payment.qrCode, '000201-test-pix');
  assert.ok(!JSON.stringify(results).includes(payer.payerDocument));
  assert.ok(!JSON.stringify(results).includes(payer.payerEmail));
}));

test('uncertain creation recovers through lookup with same reference without repeating POST', async () => configured(async () => {
  const f = fixture();
  let posts = 0;
  f.client.create = async () => { posts++; throw new Error('private document'); };
  const result = await f.service.create('my-session', f.order.id, payer);
  assert.equal(result.payment.status, 'UNKNOWN'); assert.equal(result.payment.qrCode, null);
  assert.ok(!result.payment.lastError.includes('private document'));
  await f.service.create('my-session', f.order.id, payer);
  assert.equal(posts, 1);
  assert.equal((await f.service.current('my-session', f.order.id)).payment.status, 'PENDING');
}));

test('mismatched amount/reference/id/currency never confirms the order; 404 never recreates a charge', async () => configured(async () => {
  for (const override of [{ amount: '1.99' }, { external_id: randomUUID() }, { id: 99 }, { currency: 'USD' }]) {
    const f = fixture();
    await f.service.create('my-session', f.order.id, payer);
    const payment = [...f.payments.values()][0];
    payment.lookupProviderId = '33';
    f.client.lookup = async () => ({ id: 33, external_id: payment.id, status: 'approved', amount: '2.00', currency: 'BRL', ...override });
    await assert.rejects(f.service.check('my-session', f.order.id), /MISMATCH/);
    assert.equal(f.order.paymentStatus, 'UNPAID');
  }
  const f = fixture(); await f.service.create('my-session', f.order.id, payer); f.setMissing();
  await f.service.create('my-session', f.order.id, payer); assert.equal(f.posts(), 1);
}));

test('confirmed cash-in updates payment and order atomically and never downgrades on stale pending', async () => configured(async () => {
  const f = fixture(); await f.service.create('my-session', f.order.id, payer);
  f.setStatus('approved');
  const result = await f.service.check('my-session', f.order.id);
  assert.equal(result.order.paymentStatus, 'PAID'); assert.equal(result.payment.qrCode, null);
  f.setStatus('pending');
  const payment = [...f.payments.values()][0];
  await f.service.apply(payment, { id: 33, external_id: payment.id, amount: '2.00', status: 'pending' });
  assert.equal(f.order.paymentStatus, 'PAID'); assert.equal(payment.status, 'PAID');
}));

test('mismatch diagnostics identify fields without exposing provider payload or changing payment status', async () => configured(async () => {
  const f = fixture();
  await f.service.create('my-session', f.order.id, payer);
  const warnings = [];
  f.service.logger.warn = value => warnings.push(value);
  [...f.payments.values()][0].lookupProviderId = '33';
  f.client.lookup = async () => ({ id: 'different-id', external_id: 'private-reference', amount: '9.99', currency: 'USD', status: 'approved', payer_document: 'sensitive-document', payer_email: 'private@example.com' });
  await assert.rejects(f.service.check('my-session', f.order.id), error => {
    const body = error.getResponse();
    assert.equal(body.code, 'ZETTPAY_TRANSACTION_MISMATCH');
    assert.deepEqual(body.fields, ['id_divergente', 'referencia_divergente', 'valor_divergente', 'moeda_divergente']);
    assert.ok(!JSON.stringify(body).includes('private'));
    assert.ok(!JSON.stringify(body).includes('sensitive-document'));
    assert.ok(!body.message.includes('ZETTPAY_TRANSACTION_MISMATCH'));
    return true;
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /campos=id_divergente,referencia_divergente,valor_divergente,moeda_divergente/);
  assert.ok(!warnings[0].includes('sensitive-document'));
  assert.ok(!warnings[0].includes('private@example.com'));
  assert.equal(f.order.paymentStatus, 'UNPAID');
}));

test('documented lookup response approved with opaque transaction ID and string reais confirms the matching order', async () => configured(async () => {
  const f = fixture();
  const id = 'CC7AD36013FEA1B2C3D4E2AA4070';
  f.client.create = async input => ({ id, status: 'pending', amount: '2.00', external_id: input.id, qr_code: '000201-test-pix' });
  await f.service.create('my-session', f.order.id, payer);
  const payment = [...f.payments.values()][0];
  f.client.lookup = async () => ({ id, status: 'approved', amount: '2.00', fee_amount: '0.25', external_id: payment.id, additional_fields: { order_id: f.order.id }, qr_code: '000201-test-pix' });
  const result = await f.service.check('my-session', f.order.id);
  assert.equal(result.order.paymentStatus, 'PAID');
  assert.equal(result.payment.status, 'PAID');
  assert.equal(payment.providerStatus, 'approved');
  assert.equal(result.payment.amountCents, 200);
}));

test('numeric creation ID and opaque lookup ID are bound separately and existing charges recover without another POST', async () => configured(async () => {
  const f = fixture();
  await f.service.create('my-session', f.order.id, payer);
  const payment = [...f.payments.values()][0];
  assert.equal(payment.providerId, '33'); assert.equal(payment.lookupProviderId, null);
  const canonicalId = 'CC7AD36013FEA1B2C3D4E2AA4070';
  f.client.lookup = async () => ({ id: canonicalId, external_id: payment.id, status: 'pending', amount: '2.00', qr_code: '000201-test-pix' });
  const pending = await f.service.check('my-session', f.order.id);
  assert.equal(pending.payment.status, 'PENDING');
  assert.equal(payment.providerId, '33'); assert.equal(payment.lookupProviderId, canonicalId);
  assert.equal(f.posts(), 1);
  const stale = { ...payment, lookupProviderId: null };
  await assert.rejects(f.service.apply(stale, { id: 'OTHER_LOOKUP_ID', external_id: payment.id, status: 'approved', amount: '2.00' }), /MISMATCH/);
  assert.equal(f.order.paymentStatus, 'UNPAID'); assert.equal(payment.lookupProviderId, canonicalId);
  f.client.lookup = async () => ({ id: canonicalId, external_id: payment.id, status: 'approved', amount: '2.00' });
  assert.equal((await f.service.check('my-session', f.order.id)).order.paymentStatus, 'PAID');
  assert.equal(payment.providerId, '33'); assert.equal(f.posts(), 1);
}));

test('a first lookup with another ID cannot bind or confirm if value or external reference differs', async () => configured(async () => {
  for (const override of [{ amount: '9.99' }, { external_id: randomUUID() }]) {
    const f = fixture(); await f.service.create('my-session', f.order.id, payer);
    const payment = [...f.payments.values()][0];
    f.client.lookup = async () => ({ id: 'LOOKUP_NEW_ID', external_id: payment.id, amount: '2.00', status: 'approved', ...override });
    await assert.rejects(f.service.check('my-session', f.order.id), /MISMATCH/);
    assert.equal(payment.lookupProviderId, null); assert.equal(payment.providerId, '33');
    assert.equal(f.order.paymentStatus, 'UNPAID');
  }
}));

test('signed webhook accepts the stored creation ID or canonical lookup ID and rejects unrelated IDs', async () => configured(async () => {
  for (const eventId of [33, 'LOOKUP_CANONICAL', 'UNRELATED_ID']) {
    const f = fixture(); await f.service.create('my-session', f.order.id, payer);
    const payment = [...f.payments.values()][0];
    f.client.lookup = async () => ({ id: 'LOOKUP_CANONICAL', external_id: payment.id, amount: '2.00', status: 'approved' });
    const event = { type: 'cashin', id: eventId, external_id: payment.id, status: 'approved' };
    const raw = Buffer.from(JSON.stringify(event)); const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', process.env.ZETTPAY_WEBHOOK_SIGNING_SECRET).update(`${t}.`).update(raw).digest('hex');
    const delivery = f.service.webhook(`t=${t},v1=${sig}`, raw, event);
    if (eventId === 'UNRELATED_ID') {
      await assert.rejects(delivery, /MISMATCH/); assert.equal(f.order.paymentStatus, 'UNPAID');
    } else {
      await delivery; assert.equal(f.order.paymentStatus, 'PAID');
      assert.equal(payment.providerId, '33'); assert.equal(payment.lookupProviderId, 'LOOKUP_CANONICAL');
    }
  }
}));

test('timestamped webhook signatures use exact raw bytes, reject replay/forgery, and accept a valid rotated signature', () => {
  const raw = Buffer.from('{"type":"cashin", "id":33}'); const timestamp = Math.floor(Date.now() / 1000);
  const secret = 'whsec_test';
  const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  const header = `t=${timestamp},v1=${'0'.repeat(64)},v1=${signature}`;
  assert.equal(verifyZettpaySignature(raw, header, secret), true);
  assert.equal(verifyZettpaySignature(Buffer.from(JSON.stringify(JSON.parse(raw))), header, secret), false);
  assert.equal(verifyZettpaySignature(raw, header, secret, Date.now() + 301000), false);
  assert.equal(verifyZettpaySignature(raw, header, 'wrong'), false);
  assert.equal(verifyZettpaySignature(raw, `${header},t=${timestamp}`, secret), false);
});

test('signed cash-in triggers source lookup; forged paid body cannot bypass pending; duplicate delivery is harmless', async () => configured(async () => {
  const f = fixture(); await f.service.create('my-session', f.order.id, payer);
  const payment = [...f.payments.values()][0];
  const body = { type: 'cashin', id: 33, external_id: payment.id, amount: 99999, status: 'approved' };
  const raw = Buffer.from(JSON.stringify(body)); const timestamp = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', process.env.ZETTPAY_WEBHOOK_SIGNING_SECRET).update(`${timestamp}.`).update(raw).digest('hex');
  await assert.rejects(f.service.webhook('invalid', raw, body), /Assinatura/);
  await assert.rejects(f.service.webhook(`t=${timestamp},v1=${sig}`, raw, body), /ainda não confirmado/);
  assert.equal(f.order.paymentStatus, 'UNPAID'); assert.equal(f.events.size, 0);
  f.setStatus('approved'); await f.service.webhook(`t=${timestamp},v1=${sig}`, raw, body);
  const calls = f.lookups();
  await f.service.webhook(`t=${timestamp},v1=${sig}`, raw, body);
  assert.equal(f.lookups(), calls); assert.equal(f.order.paymentStatus, 'PAID'); assert.equal(f.events.size, 1);
}));

test('initial pending webhook is acknowledged without claiming payment and cash-out is ignored', async () => configured(async () => {
  const f = fixture(); await f.service.create('my-session', f.order.id, payer);
  const payment = [...f.payments.values()][0];
  const deliver = async body => {
    const raw = Buffer.from(JSON.stringify(body)); const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', process.env.ZETTPAY_WEBHOOK_SIGNING_SECRET).update(`${t}.`).update(raw).digest('hex');
    return f.service.webhook(`t=${t},v1=${sig}`, raw, body);
  };
  await deliver({ type: 'cashin', id: 33, external_id: payment.id, status: 'pending' });
  assert.equal(f.order.paymentStatus, 'UNPAID');
  const lookups = f.lookups();
  assert.equal((await deliver({ type: 'cashout', id: 33, external_id: payment.id, status: 'approved' })).ignored, true);
  assert.equal(f.lookups(), lookups);
}));

test('HTTP checkout requires the owner session, rejects extra price fields and serves private no-store responses', async () => configured(async () => {
  require('reflect-metadata');
  const { Module, ValidationPipe } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { ParticipantService } = require('../dist/participants/participant.service');
  const { ParticipantOriginGuard } = require('../dist/participants/participant.controller');
  const { ZettpayCheckoutController, ZettpayWebhookController } = require('../dist/payments/zettpay.controller');
  const f = fixture();
  class TestModule {}
  Module({ controllers: [ZettpayCheckoutController, ZettpayWebhookController], providers: [ParticipantOriginGuard, { provide: ZettpayService, useValue: f.service }, { provide: ParticipantService, useValue: { token: cookie => cookie === 'bilhetou_participant=my-session' ? 'my-session' : undefined } }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false, rawBody: true });
  app.setGlobalPrefix('api'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  try {
    const url = `${await app.getUrl()}/api/participant/orders/${f.order.id}/payment`;
    const headers = { Cookie: 'bilhetou_participant=my-session', 'content-type': 'application/json' };
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...payer, amount: 0.01 }) })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.invalid' }, body: JSON.stringify(payer) })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: headers.Cookie, 'content-type': 'text/plain' }, body: '{}' })).status, 403);
    const result = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payer) });
    assert.equal(result.status, 201); assert.match(result.headers.get('cache-control'), /no-store/);
    assert.equal(f.posts(), 1);
    assert.equal((await fetch(`${await app.getUrl()}/api/payments/zettpay/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"cashin"}' })).status, 403);
  } finally { await app.close(); }
}));

test('expired reservation hides QR and prevents a new charge; late confirmed payment requires review', async () => configured(async () => {
  const f = fixture(); await f.service.create('my-session', f.order.id, payer);
  f.order.reservationExpiresAt = new Date(0);
  const current = await f.service.current('my-session', f.order.id);
  assert.equal(current.order.reservationExpired, true); assert.equal(current.payment.qrCode, null);
  await assert.rejects(f.service.create('my-session', f.order.id, payer), /reserva expirou/);
  f.setStatus('approved');
  const late = await f.service.check('my-session', f.order.id);
  assert.equal(late.payment.status, 'PAID'); assert.equal(late.order.paymentStatus, 'REVIEW_REQUIRED');
  const payment = [...f.payments.values()][0];
  await f.service.apply(payment, { id: 33, external_id: payment.id, amount: '2.00', status: 'pending' });
  assert.equal(f.order.paymentStatus, 'REVIEW_REQUIRED'); assert.equal(f.posts(), 1);
}));

test('PostgreSQL: pending order hides tickets, concurrent checkout charges once and source confirmation releases them', { skip: !process.env.TEST_DATABASE_URL }, async () => configured(async () => {
  const { PrismaClient } = require('../dist/generated/prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { ParticipantService } = require('../dist/participants/participant.service');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
  const org = await prisma.organization.create({ data: { name: 'ZETTPAY TEST' } });
  const previousOrg = process.env.PUBLIC_ORGANIZATION_ID;
  const previousCampaign = process.env.PUBLIC_CAMPAIGN_ID;
  process.env.PUBLIC_ORGANIZATION_ID = org.id; delete process.env.PUBLIC_CAMPAIGN_ID;
  try {
    const campaign = await prisma.campaign.create({ data: { organizationId: org.id, name: 'ZETTPAY TEST', status: 'OPEN', ticketPriceCents: 200 } });
    await prisma.$transaction(async tx => {
      const ticket = await tx.ticket.create({ data: { campaignId: campaign.id, serial: 'PIX-TEST' } });
      await tx.ticketNumber.createMany({ data: ['0001','0002','0003','0004'].map((value, i) => ({ ticketId: ticket.id, campaignId: campaign.id, value, position: i + 1 })) });
    });
    const participants = new ParticipantService(prisma);
    const registered = await participants.register('Maria Silva', '98999999999');
    const selection = await participants.select(registered.token, { quantity: 1 });
    const confirmed = await participants.confirm(registered.token, selection.selectionKey);
    assert.equal(confirmed.orders[0].tickets.length, 0);
    assert.equal(confirmed.orders[0].paymentRequired, true);
    let posts = 0; let status = 'pending';
    const providerId = `test_${randomUUID()}`;
    const creationId = Date.now();
    const transaction = id => ({ id: providerId, external_id: id, amount: '2.00', status, qr_code: '000201-integration-test' });
    const client = { create: async input => { posts++; return { ...transaction(input.id), id: creationId }; }, lookup: async id => transaction(id) };
    const workers = [new ZettpayService(prisma, participants, client), new ZettpayService(prisma, participants, client)];
    const orderId = confirmed.orders[0].id;
    await Promise.all(workers.map(worker => worker.create(registered.token, orderId, payer)));
    assert.equal(posts, 1);
    assert.equal((await participants.current(registered.token)).orders[0].tickets.length, 0);
    status = 'approved'; await workers[0].check(registered.token, orderId);
    const stored = await prisma.zettpayPayment.findUnique({ where: { orderId } });
    assert.equal(stored.providerId, String(creationId)); assert.equal(stored.lookupProviderId, providerId);
    const paid = await participants.current(registered.token);
    assert.equal(paid.orders[0].paymentStatus, 'PAID'); assert.equal(paid.orders[0].tickets.length, 1);
  } finally {
    if (previousOrg === undefined) delete process.env.PUBLIC_ORGANIZATION_ID; else process.env.PUBLIC_ORGANIZATION_ID = previousOrg;
    if (previousCampaign === undefined) delete process.env.PUBLIC_CAMPAIGN_ID; else process.env.PUBLIC_CAMPAIGN_ID = previousCampaign;
    await prisma.participantSession.deleteMany({ where: { participant: { organizationId: org.id } } });
    await prisma.zettpayPayment.deleteMany({ where: { order: { campaign: { organizationId: org.id } } } });
    await prisma.ticket.deleteMany({ where: { campaign: { organizationId: org.id } } });
    await prisma.order.deleteMany({ where: { campaign: { organizationId: org.id } } });
    await prisma.participant.deleteMany({ where: { organizationId: org.id } });
    await prisma.campaign.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.$disconnect();
  }
}));
