const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { TicketsController } = require('../dist/tickets/tickets.controller');

test('public verification: statuses, privacy, tenant scope, UUID validation and cache headers', async () => {
  const { Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const previous = process.env.PUBLIC_ORGANIZATION_ID;
  const organizationId = randomUUID();
  process.env.PUBLIC_ORGANIZATION_ID = organizationId;
  let current = null, lastQuery, reads = 0;
  const fixture = () => ({
    serial: 'BIL-000001', status: 'ASSIGNED', assignedAt: new Date(),
    numbers: ['0000', '1234', '5678', '9999'].map(value => ({ value })),
    campaign: { name: 'Campanha encerrada', closesAt: new Date('2026-10-26T22:00:00Z') },
    order: { legacySample: false, paymentStatus: 'PAID', paymentRequired: true, totalCents: 300, reservationExpiresAt: new Date(0) },
  });
  class TestModule {}
  Module({ controllers: [TicketsController], providers: [{ provide: PrismaService, useValue: {
    ticket: { findFirst: async query => { reads++; lastQuery = query; return current; } },
  } }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix('api');
  try {
    await app.listen(0, '127.0.0.1');
    const id = randomUUID();
    const url = `${await app.getUrl()}/api/tickets/${id}/verification`;
    const lookup = async () => { const response = await fetch(url); return { response, data: await response.json() }; };
    current = fixture();
    let { response, data } = await lookup();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(data.status, 'VALID');
    assert.equal(data.paymentStatus, 'PAID');
    assert.deepEqual(data.numbers, ['0000', '1234', '5678', '9999']);
    assert.deepEqual(Object.keys(data).sort(), ['serial', 'numbers', 'campaignName', 'drawAt', 'issuedAt', 'status', 'paymentStatus', 'checkedAt'].sort());
    assert.deepEqual(lastQuery.where, { id, campaign: { organizationId, legacySample: false, deletedAt: null, status: { not: 'DRAFT' } } });
    assert.equal(lastQuery.select.order.select.participant, undefined);
    assert.equal(lastQuery.select.order.select.participantId, undefined);
    assert.deepEqual(lastQuery.select.numbers.orderBy, { position: 'asc' });
    const cases = [
      ['VOID', 'PAID', 'VOID'], ['AVAILABLE', 'PAID', 'NOT_ISSUED'],
      ['ASSIGNED', 'EXPIRED', 'EXPIRED'], ['ASSIGNED', 'REVIEW_REQUIRED', 'REVIEW_REQUIRED'],
      ['ASSIGNED', 'UNPAID', 'EXPIRED'],
    ];
    for (const [ticketStatus, paymentStatus, expected] of cases) {
      current = fixture(); current.status = ticketStatus; current.order.paymentStatus = paymentStatus;
      assert.equal((await lookup()).data.status, expected);
    }
    current = fixture(); current.order.paymentStatus = 'UNPAID';
    current.order.reservationExpiresAt = new Date(Date.now() + 60000);
    assert.equal((await lookup()).data.status, 'PENDING_PAYMENT');
    current.order.reservationExpiresAt = null;
    assert.equal((await lookup()).data.status, 'PENDING_PAYMENT');
    current.order.paymentRequired = false; current.order.totalCents = 0;
    data = (await lookup()).data;
    assert.equal(data.status, 'VALID'); assert.equal(data.paymentStatus, 'NOT_REQUIRED');
    current.order = null;
    assert.equal((await lookup()).data.status, 'NOT_ISSUED');
    current = fixture(); current.order.legacySample = true;
    assert.equal((await lookup()).response.status, 404);
    current = null;
    assert.equal((await lookup()).response.status, 404);
    const before = reads;
    assert.equal((await fetch(url.replace(id, 'BIL-000001'))).status, 400);
    assert.equal(reads, before);
    delete process.env.PUBLIC_ORGANIZATION_ID;
    const admin = process.env.ADMIN_ORGANIZATION_ID;
    delete process.env.ADMIN_ORGANIZATION_ID;
    try { assert.equal((await lookup()).response.status, 404); assert.equal(reads, before); }
    finally { if (admin !== undefined) process.env.ADMIN_ORGANIZATION_ID = admin; }
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.PUBLIC_ORGANIZATION_ID; else process.env.PUBLIC_ORGANIZATION_ID = previous;
  }
});
