'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { openDatabase } = require('../src/db/database');
const { MODEL_CHOICES } = require('../src/ai/models');

test('the faster Sol migration preserves other model choices and can run twice', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec("CREATE TABLE institution_ai_settings(institution_id INTEGER PRIMARY KEY, chat_model TEXT); INSERT INTO institution_ai_settings VALUES(1,'openai/gpt-6.1-sol/medium'),(2,'openai/gpt-6-astra/high'),(3,NULL),(4,'openai/gpt-6.1-sol/high')");
    const migration = require('../src/db/migrations/013-faster-sol');
    migration.up(db); migration.up(db);
    assert.deepEqual(db.all('SELECT chat_model FROM institution_ai_settings ORDER BY institution_id').map((r) => r.chat_model), ['openai/gpt-6.1-sol/low', 'openai/gpt-6-astra/high', null, 'openai/gpt-6.1-sol/high']);
  } finally { db.close(); }
});

test('Sol and Astra never receive unsupported none/minimal reasoning levels', async () => {
  const { makeProviders } = require('../src/ai/providers');
  for (const model of ['openai/gpt-6.1-sol', 'openai/gpt-6-astra']) {
    const invalid = makeProviders({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_DEFAULT_MODEL: `${model}/none` } });
    assert.equal(invalid.status('gateway').aiEnabled, false);
    const requests = [];
    const providers = makeProviders({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_DEFAULT_MODEL: `${model}/medium`, CAMPUS_AI_VOICE_REASONING: 'none' },
      fetchImpl: async (url, options) => { requests.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: 'Hi.' } }] }); } });
    await providers.generate('gateway', 'Instructions', 'Hello', [], { task: 'voice' });
    assert.equal(requests[0].model, model);
    assert.deepEqual(requests[0].reasoning, { effort: 'low' });
  }
});

test('the model migration preserves existing settings, is additive and can be applied twice', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec("CREATE TABLE institution_ai_settings(institution_id INTEGER PRIMARY KEY, provider TEXT NOT NULL, web_search INTEGER, speech INTEGER, updated TEXT); INSERT INTO institution_ai_settings VALUES(1,'gateway',0,1,'2026-11-08')");
    const migration = require('../src/db/migrations/012-ai-model-choice');
    migration.up(db); migration.up(db);
    const saved = db.get('SELECT * FROM institution_ai_settings WHERE institution_id = 1');
    assert.equal(saved.chat_model, null);
    assert.equal(saved.provider, 'gateway');
    assert.equal(saved.web_search, 0);
    assert.equal(saved.speech, 1);
  } finally { db.close(); }
});

test('admin model choices are tenant-scoped, survive restarts and govern complete, stream and voice requests', async (t) => {
  const requests = [];
  const env = { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway', CAMPUS_AI_DEFAULT_MODEL: 'openai/gpt-6.1-terra/medium' };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return body.stream ? new Response('data: {"choices":[{"delta":{"content":"A result."}}]}\n\ndata: [DONE]\n\n') : Response.json({ choices: [{ message: { content: 'A result.' } }] });
  };
  const app = await startApp({ remote: true, env, fetchImpl });
  t.after(() => app.close());
  await app.login('admin'); await app.register('student');
  assert.equal((await app.call('student', 'GET', '/api/ai/settings')).status, 403);
  assert.equal((await app.call('student', 'PATCH', '/api/ai/settings', { model: 'openai/gpt-6-astra/high' })).status, 403);
  assert.equal((await app.call('anon', 'PATCH', '/api/ai/settings', { model: 'openai/gpt-6.1-sol/low' })).status, 401);
  const selected = await app.call('admin', 'PATCH', '/api/ai/settings', { model: 'openai/gpt-6.1-sol/low', web_search: false });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.model, 'openai/gpt-6.1-sol/low');
  assert.ok(selected.body.modelChoices.some((m) => m.id === 'openai/gpt-6-astra/high'));
  assert.equal(selected.body.providers.find((p) => p.id === 'gateway').model, selected.body.model);
  assert.equal(selected.body.summaryModel, 'openai/gpt-6-luna/low');
  // A rejected model must not partially apply a provider or tool change.
  assert.equal((await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'off', model: 'invented/model', speech: false })).status, 400);
  assert.equal((await app.call('admin', 'GET', '/api/ai/settings')).body.provider, 'gateway');
  const user = app.db.get("SELECT * FROM users WHERE email = 'student@test.invalid'");
  const { createAiService } = require('../src/ai/service');
  const restarted = createAiService({ db: app.db, env, fetchImpl });
  assert.equal(restarted.status(user).model, 'openai/gpt-6.1-sol/low');
  await restarted.complete({ user, system: 'Explain', prompt: 'A question' });
  assert.equal(requests.at(-1).model, 'openai/gpt-6.1-sol');
  assert.deepEqual(requests.at(-1).reasoning, { effort: 'low' });
  await restarted.complete({ user, system: 'Speak', prompt: 'A question', task: 'voice' });
  assert.deepEqual(requests.at(-1).reasoning, { effort: 'low' });
  await restarted.complete({ user, system: 'Summarise', prompt: 'Notes', task: 'summary' });
  assert.equal(requests.at(-1).model, 'openai/gpt-6-luna');
  for await (const chunk of restarted.stream({ user, system: 'Explain', prompt: 'A question' })) assert.equal(typeof chunk, 'string');
  assert.equal(requests.at(-1).model, 'openai/gpt-6.1-sol');
  for (const model of MODEL_CHOICES) {
    assert.equal((await app.call('admin', 'PATCH', '/api/ai/settings', { model: model.id })).status, 200);
    await restarted.complete({ user, system: 'Explain', prompt: 'A question' });
    assert.equal(requests.at(-1).model, model.id.split('/').slice(0, 2).join('/'));
  }
  const foreign = app.db.insert('INSERT INTO institutions(name, slug, created) VALUES(?, ?, ?)', 'Foreign model campus', 'foreign-model', new Date().toISOString());
  assert.equal(restarted.status({ ...user, institution_id: foreign }).model, 'openai/gpt-6.1-terra/medium', 'another institution retains its deployment model');
  await app.call('admin', 'PATCH', '/api/ai/settings', { model: '' });
  assert.equal(restarted.status(user).modelOverride, null);
  assert.equal(restarted.status(user).model, 'openai/gpt-6.1-terra/medium');
  assert.equal(restarted.status(user).webSearchAllowed, false, 'changing the model preserves tool settings');
});
