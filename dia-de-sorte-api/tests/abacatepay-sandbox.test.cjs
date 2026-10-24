const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AbacatepaySandboxService } = require('../dist/payments/abacatepay-sandbox.service');

const key = 'dev_private_test_key';
const charge = (extra = {}) => ({ id: 'pix_char_sandbox1', amount: 200, status: 'PENDING', devMode: true, brCode: '000201-sandbox-only', expiresAt: '2030-01-01T12:00:00Z', ...extra });
const reply = data => Response.json({ success: true, error: null, data });

async function sandbox(mock, run) {
  const previous = { enabled: process.env.ABACATEPAY_SANDBOX_ENABLED, key: process.env.ABACATEPAY_SANDBOX_API_KEY, fetch: global.fetch };
  process.env.ABACATEPAY_SANDBOX_ENABLED = 'true';
  process.env.ABACATEPAY_SANDBOX_API_KEY = key;
  global.fetch = mock;
  try { await run(new AbacatepaySandboxService()); }
  finally {
    global.fetch = previous.fetch;
    for (const [name, value] of [['ABACATEPAY_SANDBOX_ENABLED', previous.enabled], ['ABACATEPAY_SANDBOX_API_KEY', previous.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test('sandbox refuses disabled mode, absent keys and production keys before network activity', async () => {
  await sandbox(() => { throw new Error('must not call provider'); }, async service => {
    process.env.ABACATEPAY_SANDBOX_ENABLED = 'false';
    await assert.rejects(service.create('org'), /desativado/);
    process.env.ABACATEPAY_SANDBOX_ENABLED = 'true';
    for (const value of ['', 'prod_live_secret', 'pk_public_key']) {
      process.env.ABACATEPAY_SANDBOX_API_KEY = value;
      await assert.rejects(service.create('org'), /sandbox dev_/);
    }
  });
});

test('sandbox creates 200 centavos via v2, checks canonical ID, simulates and reads back PAID', async () => {
  const paths = [];
  let paid = false;
  await sandbox(async (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.abacatepay.com');
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    assert.equal(init.redirect, 'error');
    paths.push(new URL(url).pathname);
    if (url.endsWith('/create')) {
      const body = JSON.parse(init.body);
      assert.equal(body.method, 'PIX'); assert.equal(body.data.amount, 200);
      assert.equal(body.data.expiresIn, 900);
      return reply(charge());
    }
    assert.equal(new URL(url).searchParams.get('id'), 'pix_char_sandbox1');
    if (url.includes('/simulate-payment')) { paid = true; return reply(charge({ status: 'PENDING' })); }
    return reply({ id: 'pix_char_sandbox1', status: paid ? 'PAID' : 'PENDING' });
  }, async service => {
    const created = await service.create('org');
    assert.equal(created.amountCents, 200); assert.equal(created.devMode, true);
    assert.ok(!JSON.stringify(created).includes(key));
    assert.equal((await service.check('org', created.token)).status, 'PENDING');
    assert.equal((await service.simulate('org', created.token)).status, 'PAID');
    assert.equal((await service.simulate('org', created.token)).status, 'PAID');
  });
  assert.equal(paths.filter(path => path.endsWith('/simulate-payment')).length, 1);
});

test('sandbox signed references prevent cross-organization, arbitrary IDs, expiry and tampering', async () => {
  let calls = 0;
  await sandbox(async () => { calls++; return reply(charge()); }, async service => {
    const created = await service.create('org-a');
    await assert.rejects(service.check('org-b', created.token), /outra organização/);
    const [payload, signature] = created.token.split('.');
    const forged = Buffer.from(JSON.stringify({ id: 'pix_char_other', organizationId: 'org-a', expires: Date.now() + 10000 })).toString('base64url');
    await assert.rejects(service.check('org-a', `${forged}.${signature}`), /inválida/);
    await assert.rejects(service.simulate('org-a', 'arbitrary-id'), /inválida/);
    const expired = Buffer.from(JSON.stringify({ id: 'pix_char_sandbox1', organizationId: 'org-a', expires: 1 })).toString('base64url');
    await assert.rejects(service.check('org-a', `${expired}.${service.sign(key, expired)}`), /expirado/);
    await assert.rejects(service.check('org-a', `${payload}.${signature}.extra`), /inválida/);
    assert.equal(calls, 1);
  });
});

test('sandbox rejects non-test, incorrect amount and malformed provider responses', async () => {
  for (const data of [charge({ devMode: false }), charge({ amount: 20000 }), charge({ id: 'other' }), charge({ brCode: '' }), charge({ expiresAt: 'invalid' })]) {
    await sandbox(async () => reply(data), service => assert.rejects(service.create('org'), /Cobrança recusada/));
  }
  await sandbox(async () => Response.json({ success: false, error: 'private provider body' }), service => assert.rejects(service.create('org'), /Resposta inválida/));
});

test('provider failures are sanitized and creation timeout is never retried automatically', async () => {
  let calls = 0;
  await sandbox(async () => { calls++; throw new Error(`${key} private URL`); }, async service => {
    await assert.rejects(service.create('org'), error => !error.message.includes(key) && /não há repetição automática/.test(error.message));
    assert.equal(calls, 1);
  });
  for (const status of [401, 403, 500]) {
    await sandbox(async () => new Response('private provider details', { status }), service => assert.rejects(service.create('org'), error => !error.message.includes('private provider details')));
  }
});

test('status checks never trust another ID and simulated responses alone do not imply paid', async () => {
  await sandbox(async url => {
    if (url.endsWith('/create')) return reply(charge());
    if (url.includes('/simulate-payment')) return reply(charge({ status: 'PAID' }));
    return reply({ id: 'pix_char_sandbox1', status: 'PENDING' });
  }, async service => {
    const created = await service.create('org');
    assert.equal((await service.simulate('org', created.token)).status, 'PENDING');
    global.fetch = async () => reply({ id: 'pix_char_other', status: 'PAID' });
    await assert.rejects(service.check('org', created.token), /status inválida/);
  });
});

test('HTTP sandbox requires administrator session, allowed origin and JSON mutations', async () => {
  require('reflect-metadata');
  const { Module, ValidationPipe } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { AdminAuth, AdminSessionStore } = require('../dist/tickets/admin-auth');
  const { AbacatepaySandboxController } = require('../dist/payments/abacatepay-sandbox.controller');
  const store = new AdminSessionStore();
  store.sessions.set('test-admin', { organizationId: 'org', actor: 'test', expires: Date.now() + 60000 });
  let calls = 0;
  class TestModule {}
  Module({ controllers: [AbacatepaySandboxController], providers: [AdminAuth, { provide: AdminSessionStore, useValue: store }, { provide: AbacatepaySandboxService, useValue: {
    configuration: () => ({ enabled: true }), create: org => { calls++; assert.equal(org, 'org'); return { status: 'PENDING' }; },
  } }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  try {
    const url = `${await app.getUrl()}/api/admin/payments/abacatepay/sandbox`;
    for (const suffix of ['', '/check', '/simulate']) assert.equal((await fetch(url + suffix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(url)).status, 401);
    const headers = { Cookie: 'bilhetou_admin=test-admin', 'content-type': 'application/json' };
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.invalid' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: headers.Cookie, 'content-type': 'text/plain' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${url}/check`, { method: 'POST', headers, body: JSON.stringify({ token: 42 }) })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 201);
    assert.equal(calls, 1);
  } finally { await app.close(); }
});
