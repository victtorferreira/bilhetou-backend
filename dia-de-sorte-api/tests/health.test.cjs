const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HealthController } = require('../dist/health.controller');

test('health succeeds only after the database answers', async () => {
  let checked = false;
  const controller = new HealthController({ $queryRaw: async () => { checked = true; return [{ '?column?': 1 }]; } });
  assert.deepEqual(await controller.check(), { status: 'ok' });
  assert.equal(checked, true);
});

test('health reports 503 without exposing database credentials on failure', async () => {
  const controller = new HealthController({ $queryRaw: async () => { throw new Error('postgresql://private:secret@host/db'); } });
  await assert.rejects(controller.check(), error => {
    assert.equal(error.getStatus(), 503);
    assert.doesNotMatch(error.message, /secret|postgresql/);
    return true;
  });
});
