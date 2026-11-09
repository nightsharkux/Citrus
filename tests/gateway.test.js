'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeProviders } = require('../src/ai/providers');
const { startApp } = require('./helpers');

test('gateway uses its own server key, task models and bounded output with configurable models', async () => {
  const requests = [];
  const providers = makeProviders({
    env: { AI_GATEWAY_API_KEY: ' gateway-fixture-key ' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'An answer.' } }] }));
    },
  });
  assert.equal(await providers.generate('gateway', 'Instructions', 'Question'), 'An answer.');
  assert.equal(await providers.generate('gateway', 'Instructions', 'Notes', [], { task: 'summary', maxTokens: 800 }), 'An answer.');
  assert.equal(requests[0].url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer gateway-fixture-key');
  assert.equal(requests[0].body.model, 'openai/gpt-6.1-sol');
  assert.equal(requests[1].body.model, 'openai/gpt-6-luna');
  assert.equal(requests[1].body.max_tokens, 800);
  assert.deepEqual(requests[0].body.reasoning, { effort: 'medium' });
  assert.deepEqual(requests[1].body.reasoning, { effort: 'low' });
  assert.deepEqual(requests[0].body.provider, { sort: 'cost' });
  assert.equal(requests[0].body.models, undefined, 'no automatic model escalation');
  assert.doesNotMatch(JSON.stringify(providers.list()) + JSON.stringify(providers.status('gateway')), /fixture-key/);
  assert.equal(providers.status('gateway').transcription, 'Disabled');

  const custom = makeProviders({ env: { AI_GATEWAY_API_KEY: 'key', CAMPUS_AI_DEFAULT_MODEL: 'other/model', CAMPUS_AI_SUMMARY_MODEL: 'other/summary' } });
  assert.equal(custom.status('gateway').model, 'other/model');
  assert.equal(custom.status('gateway').summaryModel, 'other/summary');
});

test('gateway separates reasoning suffixes from model IDs for complete and streamed requests', async () => {
  const requests = [];
  const providers = makeProviders({
    env: { AI_GATEWAY_API_KEY: 'key', CAMPUS_AI_DEFAULT_MODEL: ' google/gemini-2.5-flash-lite/high ', CAMPUS_AI_SUMMARY_MODEL: 'openai/gpt-6-luna/none' },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return body.stream
        ? new Response('data: {"choices":[{"delta":{"content":"A streamed reply."}}]}\n\ndata: [DONE]\n\n')
        : Response.json({ choices: [{ message: { content: 'A reply.' } }] });
    },
  });
  assert.equal(providers.status('gateway').model, 'google/gemini-2.5-flash-lite/high');
  await providers.generate('gateway', 'Instructions', 'Question');
  assert.equal(requests.at(-1).model, 'google/gemini-2.5-flash-lite');
  assert.deepEqual(requests.at(-1).reasoning, { effort: 'high' });
  await providers.generate('gateway', 'Instructions', 'Notes', [], { task: 'summary' });
  assert.equal(requests.at(-1).model, 'openai/gpt-6-luna');
  assert.deepEqual(requests.at(-1).reasoning, { effort: 'none' });
  let reply = '';
  for await (const delta of providers.stream('gateway', 'Instructions', 'Question')) reply += delta;
  assert.equal(reply, 'A streamed reply.');
  assert.equal(requests.at(-1).model, 'google/gemini-2.5-flash-lite');
  assert.deepEqual(requests.at(-1).reasoning, { effort: 'high' });

  const bare = makeProviders({
    env: { AI_GATEWAY_API_KEY: 'key', CAMPUS_AI_DEFAULT_MODEL: 'openai/gpt-6.1-terra', CAMPUS_AI_SUMMARY_MODEL: 'other/summary' },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.reasoning, undefined, 'a bare model uses the provider default');
      assert.ok(['openai/gpt-6.1-terra', 'other/summary'].includes(body.model));
      return Response.json({ choices: [{ message: { content: 'A reply.' } }] });
    },
  });
  await bare.generate('gateway', 'Instructions', 'Question');
  await bare.generate('gateway', 'Instructions', 'Notes', [], { task: 'summary' });
});

test('invalid model slugs disable AI and never make a gateway request', async () => {
  for (const setting of ['CAMPUS_AI_DEFAULT_MODEL', 'CAMPUS_AI_SUMMARY_MODEL']) {
    for (const value of ['openai', '/model/low', 'openai//low', 'openai/model/', 'openai/model/medum', 'openai/model/low/extra', 'openai/a model/low']) {
      const providers = makeProviders({
        env: { AI_GATEWAY_API_KEY: 'key', [setting]: value },
        fetchImpl: async () => { assert.fail('invalid configuration must not reach the gateway'); },
      });
      assert.equal(providers.status('gateway').aiEnabled, false, setting + '=' + value);
      assert.match(providers.status('gateway').description, /model settings|reasoning level/);
      await assert.rejects(providers.generate('gateway', 'Instructions', 'Question'), /not configured/);
    }
  }
});

test('gateway streams only visible text and fails without trying another provider', async () => {
  let calls = 0;
  const providers = makeProviders({
    env: { AI_GATEWAY_API_KEY: 'key' },
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(JSON.parse(options.body).stream, true);
      return new Response('data: {"choices":[{"delta":{"reasoning":"private reasoning"}}]}\n\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\n\ndata: [DONE]\n\n');
    },
  });
  let answer = '';
  for await (const delta of providers.stream('gateway', 'Instructions', 'Question')) answer += delta;
  assert.equal(answer, 'Hello there');
  assert.equal(calls, 1);

  const failed = makeProviders({ env: { AI_GATEWAY_API_KEY: 'key' }, fetchImpl: async () => { calls++; throw new Error('private key details'); } });
  await assert.rejects(failed.generate('gateway', 'Instructions', 'Question'), /Cannot reach Vercel AI Gateway/);
  assert.equal(calls, 2);
  const missing = makeProviders({ env: { AI_GATEWAY_API_KEY: ' ' }, fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal(missing.status('gateway').aiEnabled, false);
  await assert.rejects(missing.generate('gateway', 'Instructions', 'Question'), /not configured/);
});

test('gateway selection is admin-only and tenant-scoped; real feature routes select the intended model', async (t) => {
  const requests = [];
  let reply = 'A fixture answer.';
  const app = await startApp({
    env: { AI_GATEWAY_API_KEY: 'gateway-fixture-secret', CAMPUS_AI_PROVIDER: 'off' },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    },
  });
  t.after(() => app.close());
  await app.login('admin');
  await app.register('student');
  const outsider = (await app.register('outsider')).body.user;
  const foreign = app.db.insert('INSERT INTO institutions(name, slug, created) VALUES(?, ?, ?)', 'Other fixture campus', 'other', new Date().toISOString());
  app.db.run('UPDATE users SET institution_id = ? WHERE id = ?', foreign, outsider.id);
  assert.equal((await app.call('student', 'PATCH', '/api/ai/settings', { provider: 'gateway' })).status, 403);
  assert.equal((await app.call('student', 'POST', '/api/ai/test')).status, 403);
  assert.equal(requests.length, 0);
  for (const provider of ['openai', 'anthropic', 'ollama']) {
    assert.equal((await app.call('admin', 'PATCH', '/api/ai/settings', { provider })).status, 400);
  }
  const selected = await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.summaryModel, 'openai/gpt-6-luna/low');
  assert.doesNotMatch(JSON.stringify(selected.body), /gateway-fixture-secret/);
  assert.equal((await app.call('admin', 'GET', '/api/ai/settings')).body.provider, 'gateway');
  assert.equal((await app.call('outsider', 'GET', '/api/assistant')).body.status.provider, 'off');
  assert.equal((await app.call('admin', 'POST', '/api/ai/test')).status, 200);
  assert.equal(requests.at(-1).model, 'openai/gpt-6.1-sol');
  assert.equal((await app.call('student', 'POST', '/api/assistant/messages', { prompt: 'Explain a linear algorithm.', task: 'summary', model: 'expensive/model' })).status, 200);
  assert.equal(requests.at(-1).model, 'openai/gpt-6.1-sol', 'clients cannot override server routing');
  assert.deepEqual(requests.at(-1).reasoning, { effort: 'medium' });

  const space = (await app.call('admin', 'POST', '/api/workspaces', { title: 'Gateway fixture meeting', kind: 'meeting' })).body;
  const base = `/api/workspaces/${space.id}`;
  assert.equal((await app.call('admin', 'POST', `${base}/notes`, { category: 'note', content: 'We agreed to review the draft tomorrow.' })).status, 201);
  assert.equal((await app.call('admin', 'POST', `${base}/analyze`, {})).status, 200);
  assert.equal(requests.at(-1).model, 'openai/gpt-6-luna');
  assert.deepEqual(requests.at(-1).reasoning, { effort: 'low' });
  await app.call('admin', 'POST', `${base}/live`, { active: true });
  await app.call('admin', 'POST', `${base}/captions`, { text: 'We will review the draft tomorrow, agree changes, then send the final copy.' });
  assert.equal((await app.call('admin', 'POST', `${base}/captions/summary`, {})).status, 200);
  assert.equal(requests.at(-1).model, 'openai/gpt-6-luna');
  assert.deepEqual(requests.at(-1).reasoning, { effort: 'low' });
  await app.call('student', 'POST', '/api/suggestions', { message: 'Improve the search filters.' });
  await app.call('student', 'POST', '/api/suggestions', { message: 'Make search results easier to scan.' });
  assert.equal((await app.call('admin', 'POST', '/api/admin/suggestions/summary')).status, 200);
  assert.equal(requests.at(-1).model, 'openai/gpt-6-luna');
  assert.deepEqual(requests.at(-1).reasoning, { effort: 'low' });

  await app.call('student', 'POST', '/api/courses/1/enroll');
  reply = JSON.stringify([{ question: 'Which growth rate is linear?', options: ['O(n)', 'O(log n)', 'O(n²)', 'O(1)'], answer: 0, explanation: 'Work grows with input size.' }]);
  const practice = await app.call('student', 'POST', '/api/revision', { course_id: 1 });
  assert.equal(practice.status, 201);
  assert.equal(practice.body.source, 'ai');
  assert.equal(requests.at(-1).model, 'openai/gpt-6.1-sol');
});
