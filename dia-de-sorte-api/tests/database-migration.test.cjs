const { test } = require('node:test');
const assert = require('node:assert/strict');
const { databaseUrl, assertDifferent, pgEnvironment, assertEmpty, sameFingerprint } = require('../scripts/migrate-render-railway.cjs');

test('migration refuses the source as its own restore destination even with another user or default port', () => {
  const source = databaseUrl('postgresql://source:secret@host/bilhetou');
  assert.throws(() => assertDifferent(source, databaseUrl('postgresql://target:other@host:5432/bilhetou')), /mesmo banco/);
  assert.doesNotThrow(() => assertDifferent(source, databaseUrl('postgresql://target:other@railway/bilhetou')));
  assert.throws(() => databaseUrl('https://example.com/database'), /PostgreSQL/);
});

test('restore refuses nonempty databases and permits a fresh destination', async () => {
  await assert.rejects(assertEmpty({ query: async () => ({ rows: [{ schema: 'public', name: 'Participant' }] }) }), /já possui tabelas/);
  await assertEmpty({ query: async () => ({ rows: [] }) });
});

test('Postgres command environment decodes credentials without relying on shell quoting', () => {
  const env = pgEnvironment(databaseUrl('postgresql://operator:p%40ss%24word@db.example:6543/bilhetou?sslmode=require'));
  assert.equal(env.PGPASSWORD, 'p@ss$word');
  assert.equal(env.PGUSER, 'operator');
  assert.equal(env.PGPORT, '6543');
  assert.equal(env.PGDATABASE, 'bilhetou');
  assert.equal(env.PGSSLMODE, 'require');
});

test('migration comparison detects changed data, removed uniqueness indexes and disabled triggers', () => {
  const original = { tables: [{ name: 'Ticket', count: '2', digest: 'abc' }], indexes: [{ name: 'unique-number' }], triggers: [{ name: 'four-numbers', enabled: 'O' }] };
  assert.equal(sameFingerprint(original, structuredClone(original)), true);
  const data = structuredClone(original); data.tables[0].digest = 'different';
  assert.equal(sameFingerprint(original, data), false);
  const indexes = structuredClone(original); indexes.indexes = [];
  assert.equal(sameFingerprint(original, indexes), false);
  const trigger = structuredClone(original); trigger.triggers[0].enabled = 'D';
  assert.equal(sameFingerprint(original, trigger), false);
});
