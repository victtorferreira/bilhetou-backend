const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { AdminTicketService } = require('../dist/tickets/admin-ticket.service');
const { ParticipantService } = require('../dist/participants/participant.service');

test('organizer supplies campaign name, price, prize and dates; creation binds server-side organization', async () => {
  let stored;
  const prisma = { organization: { findUnique: async ({ where }) => where.id === 'ORG' ? { id: 'ORG' } : null }, campaign: { create: async ({ data }) => { stored = data; return { id: 'CAMPAIGN', ...data }; } } };
  const service = new AdminTicketService(prisma);
  await service.createCampaign('ORG', { name: '  Campanha da comunidade  ', ticketPriceCents: 500, prizeCents: 100000, status: 'OPEN', closesAt: '2099-01-01T12:00:00Z' });
  assert.equal(stored.organizationId, 'ORG'); assert.equal(stored.name, 'Campanha da comunidade');
  assert.equal(stored.ticketPriceCents, 500); assert.equal(stored.prizeCents, 100000);
  assert.equal(stored.rulesVersion, 'v1');
  await assert.rejects(service.createCampaign('MISSING', { name: 'Campanha', ticketPriceCents: 500, status: 'OPEN' }), /Organização/);
  await assert.rejects(service.createCampaign('ORG', { name: 'Campanha', ticketPriceCents: 500, status: 'OPEN', closesAt: '2000-01-01T00:00:00Z' }), /futuro/);
});
test('registration excludes seeded campaigns and does not automatically create campaigns or tickets', async () => {
  const previous = process.env.PUBLIC_ORGANIZATION_ID;
  process.env.PUBLIC_ORGANIZATION_ID = 'ORG';
  try {
    const tx = { organization: { findUnique: async () => ({ id: 'ORG' }) }, campaign: { findFirst: async ({ where }) => { assert.equal(where.organizationId, 'ORG'); assert.equal(where.legacySample, false); assert.equal(where.status, 'OPEN'); return null; } } };
    const service = new ParticipantService({ $transaction: async cb => cb(tx) });
    await assert.rejects(service.register('Maria Silva', '98999999999'), /Nenhuma campanha aberta/);
  } finally { if (previous === undefined) delete process.env.PUBLIC_ORGANIZATION_ID; else process.env.PUBLIC_ORGANIZATION_ID = previous; }
});
test('participant cannot switch to a seeded or unrelated campaign', async () => {
  const previous = process.env.PUBLIC_ORGANIZATION_ID;
  process.env.PUBLIC_ORGANIZATION_ID = 'ORG';
  try {
    const session = { id: randomUUID(), participant: { organizationId: 'ORG' }, expiresAt: new Date(Date.now() + 60000) };
    const tx = { $queryRaw: async () => [], participantSession: { findUnique: async () => session }, campaign: { findFirst: async ({ where }) => { assert.equal(where.legacySample, false); assert.equal(where.organizationId, 'ORG'); return null; } } };
    await assert.rejects(new ParticipantService({ $transaction: async cb => cb(tx) }).changeCampaign('a'.repeat(64), randomUUID()), /indisponível/);
  } finally { if (previous === undefined) delete process.env.PUBLIC_ORGANIZATION_ID; else process.env.PUBLIC_ORGANIZATION_ID = previous; }
});
