const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { AdminParticipantsService } = require('../dist/participants/admin-participants.service');

// Use either a test PostgreSQL connection or an optional local PGlite installation.
// Temporary tables keep this suite isolated from existing tables and records.
test('PostgreSQL: grouping, filters, pagination and history preserve separate registrations', {
  skip: !process.env.TEST_DATABASE_URL && !process.env.TEST_PGLITE_MODULE,
}, async t => {
  const embedded = !!process.env.TEST_PGLITE_MODULE;
  const db = embedded
    ? new (require(process.env.TEST_PGLITE_MODULE).PGlite)()
    : new (require('pg').Client)({ connectionString: process.env.TEST_DATABASE_URL });
  if (!embedded) await db.connect();
  const query = (text, values = []) => db.query(text, values);
  try {
    await query('CREATE TEMP TABLE "Participant" (id uuid PRIMARY KEY, "organizationId" uuid, name text, phone text, "createdAt" timestamptz)');
    await query('CREATE TEMP TABLE "Campaign" (id uuid PRIMARY KEY, "organizationId" uuid, "legacySample" boolean)');
    await query('CREATE TEMP TABLE "Order" (id uuid PRIMARY KEY, "participantId" uuid, "campaignId" uuid, quantity int, "legacySample" boolean)');
    const org = randomUUID(), foreignOrg = randomUUID();
    const current = { id: randomUUID(), name: 'Atual', status: 'OPEN', closesAt: null };
    const old = { id: randomUUID(), name: 'Anterior', status: 'CLOSED', closesAt: null };
    const legacy = { id: randomUUID() };
    for (const campaign of [current, old, legacy]) await query('INSERT INTO "Campaign" VALUES ($1, $2, $3)', [campaign.id, org, campaign === legacy]);
    const members = [
      { name: 'Maria Silva', phone: '98999999999' },
      { name: '  MARIA   SILVA  ', phone: '98999999999' },
      { name: 'Maria Souza', phone: '98999999999' },
      { name: 'Maria Silva', phone: '98988889999' },
      { name: 'João Silva', phone: '98999999999' },
      { name: 'maria silva', phone: '98999999999' },
      { name: 'Maria Silva', phone: '98999999999', foreign: true },
      ...Array.from({ length: 21 }, (_, i) => ({ name: `Outra pessoa ${i}`, phone: `119${String(i).padStart(8, '0')}` })),
    ].map((p, i) => ({ ...p, id: randomUUID(), createdAt: new Date(Date.UTC(2026, 0, i + 1)) }));
    for (const p of members) await query('INSERT INTO "Participant" VALUES ($1, $2, $3, $4, $5)', [p.id, p.foreign ? foreignOrg : org, p.name, p.phone, p.createdAt]);
    for (const [index, campaign, quantity, sample] of [[0, current, 2, false], [1, current, 3, false], [2, current, 4, false], [1, old, 6, false], [6, current, 7, false], [0, current, 99, true], [0, legacy, 99, false]]) {
      await query('INSERT INTO "Order" VALUES ($1, $2, $3, $4, $5)', [randomUUID(), members[index].id, campaign.id, quantity, sample]);
    }
    const expectedIds = [members[0].id, members[1].id, members[5].id];
    const checkScope = where => {
      assert.deepEqual(where.participantId.in, expectedIds);
      assert.equal(where.campaign.organizationId, org);
      assert.equal(where.legacySample, false);
    };
    const tx = {
      $queryRaw: async sql => (await query(sql.text, sql.values)).rows,
      campaign: { findFirst: async ({ where }) => where.id ? [current, old].find(c => c.id === where.id) : current },
      participant: { findFirst: async ({ where }) => (await query('SELECT id, name, phone, "createdAt" FROM "Participant" WHERE id = $1 AND "organizationId" = $2', [where.id, where.organizationId])).rows[0] },
      order: {
        aggregate: async ({ where }) => { checkScope(where); return { _count: { _all: 3 }, _sum: { quantity: 11, totalCents: 3300 } }; },
        count: async ({ where }) => { checkScope(where); return 3; },
        findMany: async ({ where }) => { checkScope(where); return []; },
      },
      ticket: {
        count: async ({ where }) => { checkScope(where.order); assert.equal(where.campaign.organizationId, org); return 11; },
        findMany: async ({ where }) => { checkScope(where.order); return []; },
      },
    };
    const service = new AdminParticipantsService({ $transaction: async cb => cb(tx) });
    const list = input => service.list(org, { page: 1, query: '', activity: 'all', ...input });
    await t.test('groups before pagination and uses full phone and normalized name', async () => {
      const first = await list({});
      const second = await list({ page: 2 });
      assert.equal(first.total, 25); assert.equal(first.items.length, 20); assert.equal(second.items.length, 5);
      assert.equal(new Set([...first.items, ...second.items].map(p => p.id)).size, 25);
      const result = await list({ query: '  MARIA   SILVA  ' });
      assert.equal(result.total, 2);
      const group = result.items.find(p => p.id === members[0].id);
      assert.equal(group.registrations, 3); assert.equal(group.orders, 2); assert.equal(group.tickets, 5);
      assert.equal(group.createdAt.toISOString(), members[0].createdAt.toISOString());
      assert.equal(group.phone, undefined);
      assert.equal(result.items[0].phoneMasked, result.items[1].phoneMasked);
      assert.equal(result.summary.participants, 2); assert.equal(result.summary.tickets, 5);
    });
    await t.test('activity is determined across every registration in the group', async () => {
      const withOrders = await list({ activity: 'with_orders' });
      const withoutOrders = await list({ activity: 'without_orders' });
      assert.equal(withOrders.total, 2); assert.equal(withoutOrders.total, 23);
      assert.ok(!withoutOrders.items.some(p => p.id === members[0].id));
      assert.deepEqual(withOrders.summary, { participants: 2, orders: 3, tickets: 9 });
      const phone = await list({ query: '+55 (98) 99999-9999' });
      assert.equal(phone.total, 3);
      assert.equal((await list({ query: "%' OR true --" })).total, 0);
    });
    await t.test('campaign totals exclude legacy data and respect organization boundaries', async () => {
      const historical = await list({ campaignId: old.id, activity: 'with_orders' });
      assert.equal(historical.total, 1); assert.equal(historical.items[0].tickets, 6);
      const all = await list({ campaignScope: 'all' });
      assert.deepEqual(all.summary, { participants: 25, orders: 4, tickets: 15 });
      assert.equal((await list({ page: 999 })).page, 2);
      tx.campaign.findFirst = async () => null;
      const empty = await list({});
      assert.equal(empty.total, 25); assert.equal(empty.summary.tickets, 0);
      tx.campaign.findFirst = async () => current;
    });
    await t.test('detail, order history and ticket history resolve all group members', async () => {
      const detail = await service.detail(org, members[1].id);
      assert.equal(detail.registrations, 3); assert.equal(detail.summary.tickets, 11);
      assert.equal(detail.createdAt.toISOString(), members[0].createdAt.toISOString());
      assert.equal((await service.orders(org, members[0].id, 1)).total, 3);
      assert.equal((await service.tickets(org, members[5].id, 1)).total, 11);
      await assert.rejects(service.detail(org, members[6].id), /Participante não encontrado/);
      assert.equal((await query('SELECT count(*)::int AS count FROM "Participant"')).rows[0].count, 28);
    });
  } finally { if (embedded) await db.close(); else await db.end(); }
});
