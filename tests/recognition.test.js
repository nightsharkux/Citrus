'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startApp } = require('./helpers');
const { createRecognitionProvider } = require('../src/ai/recognition');
const loadClient = () => import(pathToFileURL(path.join(__dirname, '../public/js/features/recognition.js')).href);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('Deepgram uses a short grant, EU routing and true bilingual decoding without returning its project key', async (t) => {
  const requests = [];
  const app = await startApp({ remote: true, env: { CAMPUS_AI_PROVIDER: 'gateway', AI_GATEWAY_API_KEY: 'fixture-gateway', DEEPGRAM_API_KEY: 'fixture-project-key' },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return Response.json({ access_token: 'fixture.short.grant', expires_in: 30 }); } });
  t.after(() => app.close());
  await app.register('ana');
  const endpoint = '/api/speech/recognition-session';
  assert.equal((await app.call('anon', 'POST', endpoint, {})).status, 401);
  assert.equal((await app.call('ana', 'POST', endpoint, { language: 'xx' })).status, 400);
  assert.equal((await app.call('ana', 'POST', endpoint, {}, { headers: { Origin: 'https://other.invalid' } })).status, 403);
  assert.equal(requests.length, 0);
  const info = (await app.call('ana', 'GET', '/api/bootstrap')).body.ai.recognition;
  assert.equal(info.provider, 'deepgram');
  const r = await app.call('ana', 'POST', endpoint, { language: 'multi' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.body.token, 'fixture.short.grant');
  assert.doesNotMatch(JSON.stringify(r.body), /fixture-project-key/);
  assert.equal(requests[0].url, 'https://api.eu.deepgram.com/v1/auth/grant');
  assert.equal(requests[0].options.headers.Authorization, 'Token fixture-project-key');
  assert.deepEqual(JSON.parse(requests[0].options.body), { ttl_seconds: 30 });
  const url = new URL(r.body.url);
  assert.equal(url.searchParams.get('language'), 'multi');
  assert.deepEqual(url.searchParams.getAll('language_hint'), ['de', 'en']);
  assert.equal(url.searchParams.get('mip_opt_out'), 'true');
  assert.equal(url.searchParams.get('encoding'), null, 'MediaRecorder supplies container audio');
  for (let i = 0; i < 5; i++) assert.equal((await app.call('ana', 'POST', endpoint, { language: 'de' })).status, 200);
  assert.equal((await app.call('ana', 'POST', endpoint, {})).status, 429);
  await app.register('ben');
  assert.equal((await app.call('ben', 'POST', endpoint, {})).status, 200, 'another user has a separate connection quota');
  const institution = app.db.insert('INSERT INTO institutions(name, slug, created) VALUES(?, ?, ?)', 'Other institution', 'other-recognition', new Date().toISOString());
  app.db.run('UPDATE users SET institution_id = ? WHERE email = ?', institution, 'ben@test.invalid');
  app.db.run('INSERT INTO institution_ai_settings(institution_id, provider, updated) VALUES(?, ?, ?)', institution, 'off', new Date().toISOString());
  assert.equal((await app.call('ben', 'POST', endpoint, {})).status, 503, 'the other institution cannot bypass its disabled AI setting');
});

test('unconfigured recognition makes no requests; provider failures do not reveal credentials or response bodies', async () => {
  const absent = createRecognitionProvider({ env: {}, fetchImpl: () => { throw new Error('should not call'); } });
  assert.equal(absent.info().provider, 'browser');
  await assert.rejects(absent.session(), /not configured/);
  const failed = createRecognitionProvider({ env: { DEEPGRAM_API_KEY: 'fixture-private' }, fetchImpl: async () => new Response('fixture-private upstream details', { status: 403 }) });
  await assert.rejects(failed.session(), (e) => e.status === 503 && !e.message.includes('fixture-private'));
});

async function clientHarness(options = {}) {
  const { DeepgramRecognition, MICROPHONE_AUDIO } = await loadClient();
  const state = { stopped: 0, sessions: [], sockets: [], recorders: [], results: [], ended: 0, errors: [], constraints: null };
  const stream = { getTracks: () => [{ stop: () => state.stopped++ }] };
  class Socket {
    constructor(url, protocols) { Object.assign(this, { url, protocols, readyState: 0, bufferedAmount: 0, sent: [] }); state.sockets.push(this); }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(stream, options) { Object.assign(this, { state: 'inactive', options }); state.recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: { size: 4, lastAudio: true } }); this.onstop?.(); }
  }
  const rec = new DeepgramRecognition({ Socket, Recorder,
    getUserMedia: async (constraints) => { state.constraints = constraints; return stream; },
    requestSession: async (language) => { state.sessions.push(language); return { url: 'wss://api.eu.deepgram.com/v1/listen?language=multi', token: 'fixture.grant' }; }, ...options });
  rec.onresult = (event) => state.results.push(event);
  rec.onend = () => state.ended++;
  rec.onerror = (event) => state.errors.push(event.error);
  return { rec, state, stream, MICROPHONE_AUDIO };
}

test('live audio filters and mixed-language results feed the existing speech interfaces, and stop flushes the last audio', async (t) => {
  const { rec, state, MICROPHONE_AUDIO } = await clientHarness();
  t.after(() => rec.abort());
  rec.start(); await tick();
  const ws = state.sockets[0]; ws.open();
  assert.deepEqual(state.constraints.audio, MICROPHONE_AUDIO);
  assert.deepEqual(state.sessions, ['multi']);
  assert.deepEqual(ws.protocols, ['bearer', 'fixture.grant']);
  const result = (transcript, is_final, start = 0) => ({ type: 'Results', start, duration: 1, is_final, channel: { alternatives: [{ transcript, confidence: 0.9 }] } });
  ws.message(result('ich need', false));
  ws.message(result('Ich need the Stundenplan.', true));
  ws.message(result('Ich need the Stundenplan.', true)); // duplicate final
  ws.message(result('For morgen.', true, 1));
  assert.equal(state.results.length, 3);
  assert.equal(state.results.at(-1).results.length, 2);
  assert.equal(state.results.at(-1).results[0][0].transcript, 'Ich need the Stundenplan.');
  assert.equal(state.results.at(-1).results[1].isFinal, true);
  rec.stop();
  assert.equal(ws.sent.at(-2).lastAudio, true);
  assert.deepEqual(JSON.parse(ws.sent.at(-1)), { type: 'CloseStream' });
  ws.close();
  assert.equal(state.ended, 1);
  assert.ok(state.stopped > 0);
  assert.equal(rec.active, false);
});

test('cancelling while permission is pending releases late microphones without requesting a grant', async () => {
  let resolve;
  const { rec, state, stream } = await clientHarness({ getUserMedia: () => new Promise((r) => { resolve = r; }) });
  rec.start(); rec.abort(); resolve(stream); await tick();
  assert.equal(state.stopped, 1);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.ended, 1);
});

test('a failed session releases the microphone, while a fixed German preference reaches the service', async () => {
  const languages = [];
  const { rec, state } = await clientHarness({ requestSession: async (language) => { languages.push(language); throw new Error('unavailable'); } });
  rec.lang = 'de-DE'; rec.start(); await tick();
  assert.deepEqual(languages, ['de']);
  assert.equal(state.stopped, 1);
  assert.deepEqual(state.errors, ['network']);
  assert.equal(state.ended, 1);
});
