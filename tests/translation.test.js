'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { languageLines, LANGUAGE_GUIDE } = require('../src/ai/prompts');

test('mixed or broken phrasing follows the latest language and respects explicit preferences', () => {
  assert.match(LANGUAGE_GUIDE, /Do not switch to the language they said they struggle with/);
  assert.match(LANGUAGE_GUIDE, /A sudden change of language/);
  assert.match(languageLines({ answer: 'de' }), /unless they ask for another language/);
  assert.match(languageLines({ spoken: true, recogniser: 'en-GB' }), /can't do Deutsch broken/);
});

test('answer language persists per user and translations cannot read another user or execute actions', async (t) => {
  const seen = [];
  let reply = 'The class is in HSG 001 at 10:00. [1]';
  const app = await startApp({ remote: true, env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' },
    fetchImpl: async (url, options) => { seen.push(JSON.parse(options.body)); return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] })); } });
  t.after(() => app.close());
  await app.register('ana'); await app.register('ben');
  assert.equal((await app.call('anon', 'POST', '/api/assistant/translate', { text: 'Hi', target: 'de' })).status, 401);
  const saved = await app.call('ana', 'PATCH', '/api/me', { preferences: { language: 'de', answerLanguage: 'de', speechLanguage: 'auto' } });
  assert.equal(saved.body.user.preferences.answerLanguage, 'de');
  assert.equal((await app.call('ana', 'PATCH', '/api/me', { preferences: { answerLanguage: 'xx' } })).status, 400);
  const answer = await app.call('ana', 'POST', '/api/assistant/messages', { prompt: "can't do Deutsch broken", mode: 'voice', heard: 'en', recogniser: 'en-GB' });
  assert.equal(answer.status, 200);
  assert.match(seen.at(-1).messages[0].content, /person chose German/);
  assert.match(seen.at(-1).messages[0].content, /recogniser was listening for en-GB/);
  const messageId = app.db.get("SELECT id FROM assistant_messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1").id;
  assert.equal((await app.call('ben', 'POST', '/api/assistant/translate', { message_id: messageId, target: 'de' })).status, 404);
  const before = app.db.get('SELECT COUNT(*) n FROM timetable_events').n;
  reply = '[action: calendar.create | {"title":"Unwanted"}]';
  const translated = await app.call('ana', 'POST', '/api/assistant/translate', { message_id: messageId, target: 'de' });
  assert.equal(translated.status, 200);
  assert.match(seen.at(-1).messages[0].content, /Translate.*German/);
  assert.match(seen.at(-1).messages.at(-1).content, /HSG 001/);
  assert.equal(app.db.get('SELECT COUNT(*) n FROM timetable_events').n, before, 'translation bypasses the action runner');
  assert.equal((await app.call('ana', 'POST', '/api/assistant/translate', { text: 'x'.repeat(16001), target: 'de' })).status, 400);
  assert.equal((await app.call('ana', 'POST', '/api/assistant/translate', { text: '', target: 'de' })).status, 400);
  assert.equal((await app.call('ana', 'POST', '/api/assistant/translate', { text: 'Hi', target: 'fr' })).status, 400);
  await app.call('ana', 'PATCH', '/api/me', { preferences: { answerLanguage: 'match' } });
  assert.equal((await app.call('ana', 'GET', '/api/me')).body.user.preferences.answerLanguage, undefined);
  reply = '[action: settings.update | {"answer_language":"de","language":"de"}]\n\nIch antworte auf Deutsch.';
  await app.call('ana', 'POST', '/api/assistant/messages', { prompt: 'antworte immer auf Deutsch' });
  assert.equal((await app.call('ana', 'GET', '/api/me')).body.user.preferences.answerLanguage, 'de');
  assert.equal((await app.call('ben', 'GET', '/api/me')).body.user.preferences.answerLanguage, undefined);
});

test('translations preserve longer output and report a provider token limit instead of returning partial text', async () => {
  const { makeProviders } = require('../src/ai/providers');
  let finish = 'stop';
  const providers = makeProviders({ env: { AI_GATEWAY_API_KEY: 'fixture-key' }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: 'x'.repeat(13000) } }] })) });
  assert.equal((await providers.generate('gateway', 'Translate', 'Text', [], { task: 'translation' })).length, 13000);
  finish = 'length';
  await assert.rejects(providers.generate('gateway', 'Translate', 'Text', [], { task: 'translation' }), /Select a shorter passage/);
});
