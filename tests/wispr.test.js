'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { startApp } = require('./helpers');
const { createRecognitionProvider } = require('../src/ai/recognition');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('Wispr grants require authentication and institution access; only short-lived tokens and vocabulary reach clients', async (t) => {
  const requests = [];
  const app = await startApp({ remote: true, env: { CAMPUS_AI_PROVIDER: 'gateway', AI_GATEWAY_API_KEY: 'fixture-gateway', WISPR_FLOW_API_KEY: 'fixture-organization' },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return Response.json({ access_token: 'fixture.short.jwt' }); } });
  t.after(() => app.close());
  await app.register('ana');
  const endpoint = '/api/speech/recognition-session';
  assert.equal((await app.call('anon', 'POST', endpoint, {})).status, 401);
  assert.equal((await app.call('ana', 'POST', endpoint, { language: 'xx' })).status, 400);
  assert.equal((await app.call('ana', 'POST', endpoint, {}, { headers: { Origin: 'https://other.invalid' } })).status, 403);
  assert.equal(requests.length, 0);
  const user = app.db.get("SELECT * FROM users WHERE email = 'ana@test.invalid'");
  assert.equal((await app.call('ana', 'PUT', '/api/me/profile', { programme: 'Angewandte Informatik' })).status, 200);
  assert.equal((await app.call('ana', 'GET', '/api/bootstrap')).body.ai.recognition.provider, 'wispr');
  const result = await app.call('ana', 'POST', endpoint, { language: 'multi', context: 'private chat must not be forwarded' });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.body.token, 'fixture.short.jwt');
  assert.equal(result.body.expiresIn, 120);
  assert.deepEqual(result.body.language, ['de', 'en']);
  assert.ok(result.body.context.dictionary_context.includes('Angewandte Informatik'));
  assert.deepEqual(Object.keys(result.body.context).sort(), ['app', 'dictionary_context']);
  assert.doesNotMatch(JSON.stringify(result.body), /fixture-organization|private chat/);
  assert.equal(requests[0].url, 'https://platform-api.wisprflow.ai/api/v1/dash/generate_access_token');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-organization');
  assert.deepEqual(JSON.parse(requests[0].options.body), { client_id: `campus-${user.institution_id}-${user.id}`, duration_secs: 120 });
  for (let i = 0; i < 23; i++) assert.equal((await app.call('ana', 'POST', endpoint, {})).status, 200);
  assert.equal((await app.call('ana', 'POST', endpoint, {})).status, 429);
  await app.register('ben');
  const institution = app.db.insert('INSERT INTO institutions(name, slug, created) VALUES(?, ?, ?)', 'Other institution', 'other-wispr', new Date().toISOString());
  app.db.run('UPDATE users SET institution_id = ? WHERE email = ?', institution, 'ben@test.invalid');
  app.db.run('INSERT INTO institution_ai_settings(institution_id, provider, updated) VALUES(?, ?, ?)', institution, 'off', new Date().toISOString());
  assert.equal((await app.call('ben', 'POST', endpoint, {})).status, 503);
});

test('provider selection is explicit and Wispr failures never reveal organization credentials', async () => {
  const env = { WISPR_FLOW_API_KEY: 'fixture-private', DEEPGRAM_API_KEY: 'fixture-deepgram' };
  assert.equal(createRecognitionProvider({ env }).info().provider, 'wispr');
  assert.equal(createRecognitionProvider({ env: { ...env, CAMPUS_STT_PROVIDER: 'deepgram' } }).info().provider, 'deepgram');
  assert.equal(createRecognitionProvider({ env: { ...env, CAMPUS_STT_PROVIDER: 'browser' } }).info().provider, 'browser');
  for (const fetchImpl of [async () => new Response('fixture-private details', { status: 403 }), async () => Response.json({ access_token: 'invalid token' }), async () => { throw new Error('fixture-private'); }]) {
    const provider = createRecognitionProvider({ env, fetchImpl });
    await assert.rejects(provider.session({ user: { id: 1, institution_id: 2 } }), (e) => e.status === 503 && !e.message.includes('fixture-private'));
  }
});

async function harness(options = {}) {
  const { WisprRecognition } = await import(pathToFileURL(path.join(__dirname, '../public/js/features/wispr-recognition.js')).href);
  const state = { stopped: 0, ended: 0, closed: 0, disconnected: 0, sockets: [], processors: [], results: [], errors: [], sessions: 0 };
  const stream = { getTracks: () => [{ stop: () => state.stopped++ }] };
  const node = () => ({ connect(n) { return n; }, disconnect() { state.disconnected++; } });
  class Audio {
    constructor() { this.sampleRate = 16000; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    resume() { return Promise.resolve(); }
    close() { state.closed++; return Promise.resolve(); }
    createMediaStreamSource() { return node(); }
    createGain() { return { ...node(), gain: { value: 1 } }; }
  }
  class Worklet {
    constructor() { Object.assign(this, node()); this.port = { postMessage: (m) => state.flush = m }; state.processors.push(this); }
    packet(volume = 0.1) { this.port.onmessage?.({ data: { pcm: new Int16Array(800).buffer, volume } }); }
    flushed() { this.port.onmessage?.({ data: { flushed: true } }); }
  }
  class Socket {
    constructor(url) { Object.assign(this, { url, readyState: 0, bufferedAmount: 0, sent: [] }); state.sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  const rec = new WisprRecognition({ Audio, Worklet, Socket, getUserMedia: async () => stream,
    requestSession: async () => { state.sessions++; return { url: 'wss://platform-api.wisprflow.ai/api/v1/dash/client_ws', token: 'fixture.jwt', language: ['de', 'en'], context: { dictionary_context: ['Campus'] } }; }, ...options });
  rec.onresult = (e) => state.results.push(e);
  rec.onend = () => state.ended++;
  rec.onerror = (e) => state.errors.push(e.error);
  return { rec, state, stream };
}

test('Wispr authenticates before audio, flushes before committing and only emits one final transcript', async (t) => {
  const { rec, state } = await harness(); t.after(() => rec.abort());
  rec.start(); await tick();
  const ws = state.sockets[0]; ws.open();
  assert.equal(state.processors.length, 0);
  assert.equal(new URL(ws.url).searchParams.get('client_key'), 'Bearer fixture.jwt');
  assert.equal(ws.sent[0].type, 'auth');
  ws.message({ status: 'auth' });
  const processor = state.processors[0]; processor.packet(); processor.packet();
  assert.deepEqual(ws.sent.slice(1).map((p) => p.position), [0, 1]);
  assert.equal(Buffer.from(ws.sent[1].audio_packets.packets[0], 'base64').length, 1600);
  assert.equal(ws.sent[1].audio_packets.packet_duration, 0.05);
  ws.message({ status: 'text', final: false, body: { text: 'delete all events' } });
  assert.equal(state.results.length, 0, 'a provisional rewrite must never trigger an action');
  rec.stop(); assert.equal(state.flush, 'flush');
  assert.equal(ws.sent.at(-1).type, 'append');
  processor.packet(0); processor.flushed(); processor.flushed(); processor.packet();
  assert.deepEqual(ws.sent.at(-1), { type: 'commit', total_packets: 3 });
  assert.equal(ws.sent.filter((p) => p.type === 'commit').length, 1);
  const final = { status: 'text', final: true, body: { text: ' Keep my Termine. ' } };
  ws.message(final); ws.message(final);
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].results[0][0].transcript, 'Keep my Termine.');
  assert.equal(state.results[0].results[0].isFinal, true);
  assert.equal(state.ended, 1); assert.equal(state.closed, 1); assert.ok(state.stopped > 0);
});

test('Wispr commits after speech and a pause; errors and cancellation release capture', async () => {
  const { rec, state } = await harness();
  rec.start(); await tick(); const ws = state.sockets[0]; ws.open(); ws.message({ status: 'auth' });
  const processor = state.processors[0]; processor.packet(); processor.packet();
  for (let i = 0; i < 20; i++) processor.packet(0);
  assert.equal(state.flush, 'flush'); assert.ok(state.stopped > 0);
  ws.message({ status: 'error' });
  assert.deepEqual(state.errors, ['network']); assert.equal(state.closed, 1); assert.equal(state.ended, 1);
  let release;
  const late = await harness({ getUserMedia: () => new Promise((r) => { release = r; }) });
  late.rec.start(); late.rec.abort(); release(late.stream); await tick();
  assert.equal(late.state.sessions, 0); assert.equal(late.state.stopped, 1); assert.equal(late.state.ended, 1);
});

test('unsupported audio capture and asynchronous worklet failures clean up without throwing', async () => {
  class WrongRate { constructor() { this.sampleRate = 48000; } close() { return Promise.resolve(); } }
  const wrong = await harness({ Audio: WrongRate }); wrong.rec.start(); await tick();
  assert.deepEqual(wrong.state.errors, ['network']); assert.equal(wrong.state.stopped, 1);
  const broken = await harness({ Worklet: class { constructor() { throw new Error('worklet unavailable'); } } });
  broken.rec.start(); await tick(); const ws = broken.state.sockets[0]; ws.open();
  assert.doesNotThrow(() => ws.message({ status: 'auth' }));
  assert.deepEqual(broken.state.errors, ['network']); assert.equal(broken.state.closed, 1);
});

test('PCM capture preserves samples, encodes little-endian int16 and pads only the final packet', () => {
  let Processor; const messages = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/features/pcm-worklet.js'), 'utf8'), {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (packet) => messages.push(packet) }; } },
    registerProcessor: (name, cls) => { assert.equal(name, 'campus-pcm'); Processor = cls; },
  });
  const processor = new Processor();
  const input = Float32Array.from({ length: 950 }, (_, i) => i % 2 ? -0.5 : 0.5);
  for (let i = 0; i < input.length; i += 128) processor.process([[input.slice(i, i + 128)]]);
  assert.equal(messages.length, 1);
  processor.port.onmessage({ data: 'flush' });
  assert.equal(messages.length, 3); assert.equal(messages[2].flushed, true);
  const first = new DataView(messages[0].pcm); const last = new DataView(messages[1].pcm);
  assert.equal(first.byteLength, 1600); assert.equal(last.byteLength, 1600);
  for (let i = 0; i < 800; i++) assert.equal(first.getInt16(i * 2, true), i % 2 ? -16384 : 16384);
  for (let i = 0; i < 800; i++) assert.equal(last.getInt16(i * 2, true), i < 150 ? (i % 2 ? -16384 : 16384) : 0);
  assert.equal(messages[0].volume, 0.5);
  assert.equal(processor.process([[input]]), false);
  processor.port.onmessage({ data: 'flush' }); assert.equal(messages.length, 3);
});

test('draining a 24 kHz transcription turn preserves its tail and keeps capturing the next words', () => {
  let Processor; const messages = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/features/pcm-worklet.js'), 'utf8'), {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (packet) => messages.push(packet) }; } },
    registerProcessor: (name, cls) => { Processor = cls; },
  });
  const processor = new Processor({ processorOptions: { frameSamples: 1200 } });
  processor.process([[Float32Array.from({ length: 1250 }, () => 0.5)]]);
  processor.port.onmessage({ data: 'drain' });
  assert.equal(messages[2].drained, true);
  assert.equal(new DataView(messages[1].pcm).getInt16(49 * 2, true), 16384);
  assert.equal(new DataView(messages[1].pcm).getInt16(50 * 2, true), 0);
  assert.equal(processor.process([[Float32Array.from({ length: 1200 }, () => -0.5)]]), true);
  assert.equal(new DataView(messages[3].pcm).getInt16(0, true), -16384);
  processor.port.onmessage({ data: 'flush' });
  assert.equal(messages.at(-1).flushed, true);
  assert.equal(processor.process([[]]), false);
});
