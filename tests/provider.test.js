"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeProviders } = require('../src/ai/providers');
const { startApp } = require('./helpers');

test('retired providers and their credentials cannot make requests', async () => {
  const providers = makeProviders({
    env: { AI_GATEWAY_API_KEY: 'gateway-key', OPENAI_API_KEY: 'retired-key', ANTHROPIC_API_KEY: 'retired-key' },
    fetchImpl: async () => assert.fail('Retired providers must never make requests'),
  });
  assert.deepEqual(providers.list().map(p => p.id), ['off', 'gateway']);
  for (const mode of ['openai', 'anthropic', 'ollama', 'off']) {
    assert.equal(providers.status(mode).aiEnabled, false);
    await assert.rejects(providers.generate(mode, 'test', 'test'), /not configured/);
  }
  const retiredKeysOnly = makeProviders({ env: { OPENAI_API_KEY: 'retired-key', ANTHROPIC_API_KEY: 'retired-key' } });
  assert.equal(retiredKeysOnly.status('gateway').aiEnabled, false);
});

test('a saved retired provider stays disabled until an administrator selects Gateway', async (t) => {
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' } });
  t.after(() => app.close());
  await app.login('admin');
  for (const provider of ['openai', 'anthropic', 'ollama']) {
    app.db.run('INSERT INTO institution_ai_settings(institution_id, provider, updated) VALUES(1, ?, ?) ON CONFLICT(institution_id) DO UPDATE SET provider = excluded.provider', provider, new Date().toISOString());
    const status = (await app.call('admin', 'GET', '/api/ai/settings')).body;
    assert.equal(status.provider, 'off');
    assert.equal(status.aiEnabled, false, 'never silently switch an institution to cloud AI');
  }
  assert.equal((await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' })).body.aiEnabled, true);
});
