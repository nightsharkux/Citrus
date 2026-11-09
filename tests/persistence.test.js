'use strict';
/** Accounts must not silently vanish: the server says so when it runs somewhere that does not keep its disk. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { startApp } = require('./helpers');

test('a hosted platform without a hosted database is flagged; a database, a volume or a normal machine are not', () => {
  const durable = (env) => loadConfig(env).persistence;
  assert.deepEqual(durable({}), { durable: true }, 'a laptop or a server with its own disk');
  assert.deepEqual(durable({ VERCEL: '1' }), { durable: false, platform: 'Vercel' });
  assert.deepEqual(durable({ RENDER: 'true' }), { durable: false, platform: 'Render' });
  assert.equal(durable({ VERCEL: '1', TURSO_DATABASE_URL: 'libsql://x.turso.io', TURSO_AUTH_TOKEN: 't' }).durable, true);
  assert.equal(durable({ RAILWAY_ENVIRONMENT: 'production', CAMPUS_PERSISTENT_DISK: '1' }).durable, true, 'the owner confirms a permanent volume');
});

test('the bootstrap tells the browser whether data is kept', async () => {
  const app = await startApp();
  try {
    const boot = await app.call('anon', 'GET', '/api/bootstrap');
    assert.equal(boot.body.durable, true);
  } finally {
    await app.close();
  }
});
