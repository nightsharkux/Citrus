'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { startApp } = require('./helpers');
const { createRecognitionProvider } = require('../src/ai/recognition');

const load = (name) => import(pathToFileURL(path.join(__dirname, '../public/js/features', name)).href);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const grant = (kind) => ({ token: 'vcst_fixture', provider: 'gateway', model: kind === 'speech' ? 'elevenlabs/eleven-flash-v2.5' : 'openai/gpt-live-transcribe',
  url: `wss://ai-gateway.vercel.sh/v4/ai/${kind}-model?ai-model-id=${kind === 'speech' ? 'elevenlabs/eleven-flash-v2.5' : 'openai/gpt-live-transcribe'}` });

class Socket {
  static all = [];
  constructor(url, protocols) { Object.assign(this, { url, protocols, sent: [], bufferedAmount: 0, readyState: 0 }); Socket.all.push(this); }
  send(data) { this.sent.push(data); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

test('Gateway audio uses model-bound single-use grants and honors authentication, CSRF, quotas and institution switches', async (t) => {
  const calls = [];
  const app = await startApp({ env: { CAMPUS_AI_PROVIDER: 'gateway', AI_GATEWAY_API_KEY: 'fixture-private', CAMPUS_AI_SPEECH_PER_MINUTE: '2' },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ token: 'vcst_one_use', expiresAt: 2000000000 }); } });
  t.after(() => app.close());
  await app.login('admin'); await app.register('ana'); await app.register('ben');
  const playback = '/api/speech/playback-session';
  const recognition = '/api/speech/recognition-session';
  assert.equal((await app.call('anon', 'POST', playback, {})).status, 401);
  assert.equal((await app.call('ana', 'POST', playback, {}, { headers: { Origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await app.call('ana', 'POST', playback, { speed: 5 })).status, 400);
  assert.equal(calls.length, 0);
  const r = await app.call('ana', 'POST', playback, { voice: 'unapproved', speed: 1.5, model: 'unapproved/model' });
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.body.model, 'elevenlabs/eleven-flash-v2.5');
  assert.equal(r.body.voice, 'hpp4J3VqNfWAUOO0d1Us'); assert.equal(r.body.speed, 1.2);
  assert.deepEqual(r.body.outputFormat, { type: 'audio/pcm', rate: 24000 });
  assert.equal(calls[0].url, 'https://ai-gateway.vercel.sh/v1/realtime/client-secrets');
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: r.body.model, routeKind: 'speech', expiresIn: 60 });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-private');
  assert.doesNotMatch(JSON.stringify(r.body), /fixture-private/);
  assert.equal((await app.call('ana', 'POST', playback, {})).status, 200);
  assert.equal((await app.call('ana', 'POST', playback, {})).status, 429);
  assert.equal((await app.call('ana', 'POST', '/api/speech', { text: 'Also counted.' })).status, 429, 'buffered speech shares the same quota');
  assert.equal((await app.call('ben', 'POST', playback, {})).status, 200);
  const stt = await app.call('ana', 'POST', recognition, { language: 'de' });
  assert.equal(stt.status, 200); assert.equal(stt.body.model, 'openai/gpt-live-transcribe');
  assert.deepEqual(stt.body.options, { openai: { language: 'de', streaming: { delay: 'low' } } });
  assert.equal(JSON.parse(calls.at(-1).options.body).routeKind, 'transcription');
  const other = app.db.insert('INSERT INTO institutions(name, slug, created) VALUES(?, ?, ?)', 'Other', 'other-audio', new Date().toISOString());
  app.db.run('UPDATE users SET institution_id = ? WHERE email = ?', other, 'ben@test.invalid');
  app.db.run('INSERT INTO institution_ai_settings(institution_id, provider, updated) VALUES(?, ?, ?)', other, 'off', new Date().toISOString());
  assert.equal((await app.call('ben', 'POST', playback, {})).status, 503);
  assert.equal((await app.call('ben', 'POST', recognition, {})).status, 503);
  assert.equal((await app.call('ana', 'POST', recognition, {})).status, 200);
  await app.call('admin', 'PATCH', '/api/ai/settings', { speech: false });
  assert.equal((await app.call('ana', 'POST', playback, {})).status, 503);
  assert.equal((await app.call('ana', 'POST', recognition, {})).status, 200, 'speech output and recognition have separate switches');
});

test('configured recognition choices are preserved and failed Gateway grants never expose upstream details', async () => {
  const env = { AI_GATEWAY_API_KEY: 'fixture-private' };
  assert.equal(createRecognitionProvider({ env }).info().provider, 'gateway');
  assert.equal(createRecognitionProvider({ env: { ...env, CAMPUS_STT_PROVIDER: 'browser' } }).info().enabled, false);
  assert.equal(createRecognitionProvider({ env: { ...env, DEEPGRAM_API_KEY: 'fixture-dg' } }).info().provider, 'deepgram');
  const failed = createRecognitionProvider({ env, fetchImpl: async () => new Response('fixture-private details', { status: 403 }) });
  await assert.rejects(failed.session(), (e) => e.status === 503 && !e.message.includes('fixture-private'));
  const invalid = createRecognitionProvider({ env, fetchImpl: async () => Response.json({ token: 'invalid token' }) });
  await assert.rejects(invalid.session(), { status: 503 });
});

test('streamed speech delivers audio before text ends, preserves order, and cancels once without late audio', async () => {
  const { StreamingSpeech, gatewaySocket } = await load('gateway-audio.js');
  const state = { audio: [], ended: 0, errors: 0 };
  const speech = new StreamingSpeech({ Socket, requestSession: async () => ({ ...grant('speech'), voice: 'bella', speed: 1, outputFormat: { type: 'audio/pcm', rate: 24000 } }),
    onAudio: (audio) => state.audio.push(audio), onFinish: () => state.ended++, onError: () => state.errors++ });
  speech.feed('First sentence. ');
  await speech.start(); const socket = Socket.all.at(-1); socket.open();
  assert.deepEqual(socket.protocols, ['ai-gateway-speech.v1', 'ai-gateway-auth.vcst_fixture']);
  assert.ok(!socket.url.includes('vcst_'));
  socket.message({ type: 'audio', audio: 'AAABAA==', audioFormat: { type: 'audio/pcm', rate: 24000 } });
  assert.equal(state.audio.length, 1, 'the first audio is playable while text is still arriving');
  speech.feed('Second sentence.'); speech.end();
  const frames = socket.sent.map((s) => JSON.parse(s));
  assert.equal(frames[0].type, 'speech-stream.start');
  assert.equal(frames.filter((f) => f.type === 'speech-stream.text-delta').map((f) => f.delta).join(''), 'First sentence. Second sentence.');
  assert.equal(frames.at(-1).type, 'speech-stream.text-done');
  socket.message({ type: 'finish' });
  assert.equal(state.ended, 1); assert.equal(state.errors, 0); assert.equal(socket.readyState, 3);
  speech.cancel(); socket.message({ type: 'audio', audio: 'AAAA' });
  assert.equal(state.audio.length, 1);
  assert.throws(() => gatewaySocket({ ...grant('speech'), url: 'wss://other.invalid/v4/ai/speech-model' }, 'speech', Socket));
});

test('speech timeout, unexpected close and unsupported audio all report failure and close the socket', async () => {
  const { StreamingSpeech } = await load('gateway-audio.js');
  for (const failure of ['timeout', 'close', 'format']) {
    let errors = 0;
    const speech = new StreamingSpeech({ Socket, timeout: 15, requestSession: async () => grant('speech'), onAudio() {}, onFinish() { assert.fail('must not finish'); }, onError() { errors++; } });
    await speech.start(); const socket = Socket.all.at(-1); socket.open();
    if (failure === 'close') socket.close();
    else if (failure === 'format') socket.message({ type: 'audio', audio: 'AAAA', audioFormat: { type: 'audio/mpeg' } });
    else await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(errors, 1); assert.equal(socket.readyState, 3);
    speech.cancel(); assert.equal(errors, 1);
  }
  let requests = 0; let errors = 0;
  const oversized = new StreamingSpeech({ Socket, requestSession: async () => { requests++; return grant('speech'); }, onAudio() {}, onFinish() {}, onError() { errors++; } });
  oversized.feed('a'.repeat(12001)); await oversized.start();
  assert.equal(errors, 1); assert.equal(requests, 0, 'a cancelled or oversized stream cannot request another grant');
});

async function recognitionHarness(options = {}) {
  const { GatewayRecognition } = await load('gateway-recognition.js');
  const state = { tracks: 0, closed: 0, results: [], ended: 0, grants: 0, errors: [] };
  class Audio {
    constructor({ sampleRate }) { this.sampleRate = sampleRate; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    resume() { return Promise.resolve(); } close() { state.closed++; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: {}, connect: (n) => n, disconnect() {} }; }
  }
  class Worklet {
    constructor(context, name, options) { this.options = options; state.worklet = this; this.port = { postMessage: () => {
      this.port.onmessage?.({ data: { pcm: new ArrayBuffer(4), volume: 0 } }); this.port.onmessage?.({ data: { flushed: true } });
    }, close() {} }; }
    connect(n) { return n; } disconnect() {}
  }
  const rec = new GatewayRecognition({ Audio, Worklet, Socket, getUserMedia: async () => ({ getTracks: () => [{ stop: () => state.tracks++ }] }),
    requestSession: async () => { state.grants++; return { ...grant('transcription'), options: { openai: { streaming: { delay: 'low' } } } }; }, ...options });
  rec.onresult = (e) => state.results.push(e); rec.onend = () => state.ended++; rec.onerror = (e) => state.errors.push(e.error);
  return { rec, state };
}

test('OpenAI recognition streams 24 kHz PCM, emits revisions and finals once, then flushes and releases capture', async (t) => {
  const { rec, state } = await recognitionHarness(); t.after(() => rec.abort());
  rec.start(); await tick();
  const socket = Socket.all.at(-1); socket.open(); socket.message({ type: 'stream-start', warnings: [] });
  assert.equal(state.worklet.options.processorOptions.frameSamples, 1200);
  assert.equal(JSON.parse(socket.sent[0]).inputAudioFormat.rate, 24000);
  state.worklet.port.onmessage({ data: { pcm: new ArrayBuffer(2400), volume: 0.1 } });
  assert.ok(socket.sent[1] instanceof ArrayBuffer);
  socket.message({ type: 'transcript-delta', id: 'one', delta: 'Ich need' });
  socket.message({ type: 'transcript-partial', id: 'one', text: 'Ich brauche my timetable.' });
  socket.message({ type: 'transcript-final', id: 'one', text: 'Ich brauche my timetable.' });
  socket.message({ type: 'transcript-final', id: 'one', text: 'Ich brauche my timetable.' });
  assert.equal(state.results.length, 3);
  socket.message({ type: 'transcript-delta', id: 'two', delta: 'For tomorrow.' });
  assert.equal(state.results.at(-1).resultIndex, 1, 'earlier final segments are not sent twice to captions');
  rec.stop();
  assert.ok(socket.sent.at(-2) instanceof ArrayBuffer, 'the tail precedes the done frame');
  assert.equal(JSON.parse(socket.sent.at(-1)).type, 'transcription-stream.audio-done');
  socket.message({ type: 'finish', text: 'Ich brauche my timetable. For tomorrow.', segments: [] });
  assert.equal(state.results.at(-1).resultIndex, 1); assert.equal(state.results.at(-1).results[1].isFinal, true);
  assert.equal(state.ended, 1); assert.equal(state.closed, 1); assert.ok(state.tracks > 0); assert.equal(socket.readyState, 3);
});

test('OpenAI recognition commits on a measured pause and cleans up pending permission and provider errors', async (t) => {
  const { rec, state } = await recognitionHarness(); t.after(() => rec.abort());
  rec.start(); await tick(); const socket = Socket.all.at(-1); socket.open(); socket.message({ type: 'stream-start', warnings: [] });
  const packet = (volume) => state.worklet.port.onmessage({ data: { pcm: new ArrayBuffer(2400), volume } });
  packet(0.1); packet(0.1);
  for (let i = 0; i < 14; i++) packet(0);
  socket.message({ type: 'finish', text: 'Please open the timetable.', segments: [] });
  assert.equal(state.results[0].results.silenceMs, 700);
  const { endOfTurnDelay } = await load('turns.js');
  assert.equal(endOfTurnDelay('Please open the timetable.', { final: true, silenceMs: 700 }), 100, 'a measured pause is not charged twice');
  assert.ok(endOfTurnDelay('I need help with', { final: true, silenceMs: 700 }) > 700, 'unfinished phrases still have time to continue');
  assert.equal(state.ended, 1);
  const failed = await recognitionHarness(); failed.rec.start(); await tick();
  const bad = Socket.all.at(-1); bad.open(); bad.message({ type: 'error', error: { message: 'upstream details' } });
  assert.deepEqual(failed.state.errors, ['network']); assert.equal(failed.state.closed, 1);
  let release; let stopped = 0;
  const pending = await recognitionHarness({ getUserMedia: () => new Promise((resolve) => { release = resolve; }) });
  pending.rec.start(); pending.rec.abort();
  release({ getTracks: () => [{ stop: () => stopped++ }] }); await tick();
  assert.equal(stopped, 1); assert.equal(pending.state.grants, 0);
});
