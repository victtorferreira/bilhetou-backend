const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { AdminAuth, AdminSessionStore } = require('../dist/tickets/admin-auth');

test('controller auth and a separate guard share sessions and logout revocations', () => {
  const previous = { key: process.env.ADMIN_ACCESS_KEY, org: process.env.ADMIN_ORGANIZATION_ID };
  process.env.ADMIN_ACCESS_KEY = 'a'.repeat(40); process.env.ADMIN_ORGANIZATION_ID = randomUUID();
  try {
    const store = new AdminSessionStore();
    const loginAuth = new AdminAuth(store);
    const guard = new AdminAuth(store);
    const token = loginAuth.login('a'.repeat(40), 'local');
    const request = { headers: { cookie: `bilhetou_admin=${token}` } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) };
    assert.equal(guard.canActivate(context), true);
    loginAuth.logout(request);
    assert.throws(() => guard.canActivate(context));
  } finally {
    if (previous.key === undefined) delete process.env.ADMIN_ACCESS_KEY; else process.env.ADMIN_ACCESS_KEY = previous.key;
    if (previous.org === undefined) delete process.env.ADMIN_ORGANIZATION_ID; else process.env.ADMIN_ORGANIZATION_ID = previous.org;
  }
});

test('HTTP login cookie authorizes session and dashboard across Nest guard instances; logout revokes both', async () => {
  require('reflect-metadata');
  const { Module, ValidationPipe } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { AdminSessionController, AdminTicketsController } = require('../dist/tickets/admin.controller');
  const { AdminTicketService } = require('../dist/tickets/admin-ticket.service');
  const { TicketCreationService } = require('../dist/tickets/ticket-creation.service');
  const previous = { key: process.env.ADMIN_ACCESS_KEY, org: process.env.ADMIN_ORGANIZATION_ID };
  process.env.ADMIN_ACCESS_KEY = 'a'.repeat(40); process.env.ADMIN_ORGANIZATION_ID = randomUUID();
  class TestModule {}
  Module({ controllers: [AdminSessionController, AdminTicketsController], providers: [AdminSessionStore, AdminAuth, { provide: AdminTicketService, useValue: { dashboard: async org => ({ organizationId: org, tickets: 1 }) } }, { provide: TicketCreationService, useValue: {} }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  try {
    const base = `${await app.getUrl()}/api/admin`;
    assert.equal((await fetch(`${base}/dashboard`)).status, 401);
    const login = await fetch(`${base}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: process.env.ADMIN_ACCESS_KEY }) });
    assert.equal(login.status, 201);
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie); assert.match(cookie, /HttpOnly/);
    const headers = { Cookie: cookie.split(';')[0] };
    const session = await fetch(`${base}/session`, { headers });
    assert.equal(session.status, 200); assert.match(session.headers.get('cache-control'), /no-store/);
    assert.equal((await session.json()).organizationId, process.env.ADMIN_ORGANIZATION_ID);
    const dashboard = await fetch(`${base}/dashboard`, { headers });
    assert.equal(dashboard.status, 200); assert.equal((await dashboard.json()).tickets, 1);
    assert.equal((await fetch(`${base}/session/logout`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status, 201);
    assert.equal((await fetch(`${base}/session`, { headers })).status, 401);
    assert.equal((await fetch(`${base}/dashboard`, { headers })).status, 401);
  } finally {
    await app.close();
    if (previous.key === undefined) delete process.env.ADMIN_ACCESS_KEY; else process.env.ADMIN_ACCESS_KEY = previous.key;
    if (previous.org === undefined) delete process.env.ADMIN_ORGANIZATION_ID; else process.env.ADMIN_ORGANIZATION_ID = previous.org;
  }
});
