const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AdminTicketService } = require('../dist/tickets/admin-ticket.service');
const { CampaignsController } = require('../dist/campaigns/campaigns.controller');
const { TicketCreationService } = require('../dist/tickets/ticket-creation.service');

test('campaign deletion locks the organization-scoped campaign and preserves its related records', async () => {
  const calls = [];
  const tx = {
    $queryRaw: async (sql, ...values) => { calls.push('lock'); assert.deepEqual(values, ['CAMPAIGN', 'ORG']); },
    campaign: {
      findFirst: async ({ where }) => { calls.push('lookup'); assert.deepEqual(where, { id: 'CAMPAIGN', organizationId: 'ORG', legacySample: false, deletedAt: null }); return { id: 'CAMPAIGN' }; },
      update: async ({ where, data }) => { calls.push('update'); assert.deepEqual(where, { id: 'CAMPAIGN' }); assert.equal(data.status, 'ARCHIVED'); assert.ok(data.deletedAt instanceof Date); },
    },
  };
  const service = new AdminTicketService({ $transaction: async cb => cb(tx) });
  assert.deepEqual(await service.deleteCampaign('ORG', 'CAMPAIGN'), { id: 'CAMPAIGN', deleted: true });
  assert.deepEqual(calls, ['lock', 'lookup', 'update']);
});

test('missing, deleted or other-organization campaigns cannot be deleted', async () => {
  const tx = { $queryRaw: async () => [], campaign: { findFirst: async () => null, update: async () => assert.fail('must not mutate a campaign outside scope') } };
  const service = new AdminTicketService({ $transaction: async cb => cb(tx) });
  await assert.rejects(service.deleteCampaign('OTHER_ORG', 'CAMPAIGN'), error => error.getStatus() === 404);
});

test('deleted campaigns are excluded from the administrative and public lists', async () => {
  const prisma = { campaign: { findMany: async ({ where }) => { assert.equal(where.deletedAt, null); assert.equal(where.legacySample, false); return []; } } };
  assert.deepEqual(await new AdminTicketService(prisma).campaigns('ORG'), []);
  assert.deepEqual(await new CampaignsController(prisma).list(), []);
});

test('a deleted campaign cannot generate a new ticket preview even if its status is OPEN', async () => {
  const tx = { campaign: { findUnique: async () => ({ id: 'CAMPAIGN', organizationId: 'ORG', status: 'OPEN', legacySample: false, deletedAt: new Date() }) } };
  const service = new TicketCreationService({ $transaction: async cb => cb(tx) });
  await assert.rejects(service.preview('CAMPAIGN', { quantity: 1, prefix: 'BIL' }, 'ORG'), error => error.getStatus() === 404);
});
