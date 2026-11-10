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
  assert.deepEqual(stt.body.options, { openai: { language: 'de', streaming: { delay: 'medium' } } });
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
  const state = { tracks: 0, opened: 0, started: 0, activity: [], closed: 0, results: [], ended: 0, grants: 0, errors: [] };
  class Audio {
    constructor({ sampleRate }) { this.sampleRate = sampleRate; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    resume() { return Promise.resolve(); } close() { state.closed++; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: {}, connect: (n) => n, disconnect() {} }; }
  }
  class Worklet {
    constructor(context, name, options) { this.options = options; state.worklet = this; this.port = { postMessage: (command) => {
      this.port.onmessage?.({ data: { pcm: new ArrayBuffer(4), volume: 0 } }); this.port.onmessage?.({ data: command === 'drain' ? { drained: true } : { flushed: true } });
    }, close() {} }; }
    connect(n) { return n; } disconnect() {}
  }
  const rec = new GatewayRecognition({ Audio, Worklet, Socket, getUserMedia: async () => { state.opened++; return { getTracks: () => [{ stop: () => state.tracks++ }] }; },
    requestSession: async () => { state.grants++; return { ...grant('transcription'), options: { openai: { streaming: { delay: 'medium' } } } }; }, ...options });
  rec.onresult = (e) => state.results.push(e); rec.onend = () => state.ended++; rec.onerror = (e) => state.errors.push(e.error);
  rec.onstart = () => state.started++; rec.onactivity = (event) => state.activity.push(event.speaking);
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

const sendPackets = (state, count, volume = 0) => {
  for (let i = 0; i < count; i++) state.worklet.port.onmessage({ data: { pcm: new ArrayBuffer(2400), volume } });
};
const ready = (socket = Socket.all.at(-1)) => { socket.open(); socket.message({ type: 'stream-start', warnings: [] }); return socket; };

test('brief pauses and quieter speech do not close capture or finalize an unfinished phrase', async (t) => {
  const { rec, state } = await recognitionHarness(); t.after(() => rec.abort());
  rec.start(); await tick(); const socket = ready();
  sendPackets(state, 4, 0.05);
  socket.message({ type: 'transcript-delta', id: 'one', delta: 'Can you help me with' });
  sendPackets(state, 30); // a 1.5-second thinking pause
  assert.equal(rec.stopping, false); assert.equal(state.tracks, 0);
  assert.ok(!socket.sent.some((data) => typeof data === 'string' && JSON.parse(data).type === 'transcription-stream.audio-done'));
  sendPackets(state, 8, 0.004); // quiet speech below the former 0.008 cutoff
  socket.message({ type: 'transcript-partial', id: 'one', text: 'Can you help me with my timetable?' });
  sendPackets(state, 30);
  assert.equal(state.tracks, 0); assert.equal(state.grants, 1);
  sendPackets(state, 15);
  assert.equal(JSON.parse(socket.sent.at(-1)).type, 'transcription-stream.audio-done');
  assert.equal(state.tracks, 0, 'committing an utterance leaves the microphone open');
  socket.message({ type: 'finish', text: 'Can you help me with my timetable?', segments: [] });
  await tick();
  assert.equal(state.results.at(-1).results[0].isFinal, true);
  assert.ok(state.results.at(-1).results.silenceMs >= 2200);
  assert.equal(state.opened, 1); assert.equal(state.started, 1); assert.equal(state.ended, 0);
  assert.ok(state.activity.includes(true) && state.activity.includes(false));
});

test('audio captured during initial setup and between transcription connections is sent without reacquiring the microphone', async (t) => {
  let resolveGrant;
  const { rec, state } = await recognitionHarness({ requestSession: () => new Promise((resolve) => { resolveGrant = resolve; }) });
  t.after(() => rec.abort());
  rec.start(); await tick();
  assert.equal(state.started, 1, 'Listening means capture has actually started');
  sendPackets(state, 3, 0.05);
  resolveGrant(grant('transcription')); await tick(); const first = ready();
  assert.equal(first.sent.filter((data) => data instanceof ArrayBuffer).length, 3);
  first.message({ type: 'transcript-partial', id: 'one', text: 'Tell me about my timetable.' });
  rec.commit();
  sendPackets(state, 5, 0.05); // user continues while the old transcript is finalized
  first.message({ type: 'finish', text: 'Tell me about my timetable.', segments: [] });
  await tick();
  assert.equal(state.results.at(-1).results.audioPending, true, 'new speech holds the reply even before its transcript arrives');
  sendPackets(state, 2, 0.05); // and during the next grant
  resolveGrant(grant('transcription')); await tick(); const second = ready();
  assert.notEqual(first, second);
  assert.equal(second.sent.filter((data) => data instanceof ArrayBuffer).length, 7, 'all buffered speech arrives in the next connection');
  second.message({ type: 'transcript-partial', id: 'one', text: 'Actually, I meant tomorrow afternoon.' });
  const result = state.results.at(-1).results;
  assert.deepEqual(result.map((item) => item[0].transcript), ['Tell me about my timetable.', 'Actually, I meant tomorrow afternoon.']);
  assert.equal(state.opened, 1); assert.equal(state.tracks, 0);
  assert.equal(state.started, 1); assert.equal(state.ended, 0);
});

test('interim corrections cannot trigger a reply; explicit commit waits for the final transcript', async (t) => {
  const { endOfTurnDelay } = await load('turns.js');
  const { rec, state } = await recognitionHarness(); t.after(() => rec.abort());
  rec.start(); await tick(); const socket = ready();
  socket.message({ type: 'transcript-partial', id: 'one', text: 'Ich brauche meinen Studenplan.' });
  let results = state.results.at(-1).results;
  assert.equal(endOfTurnDelay(results[0][0].transcript, { ...results, final: false }), null);
  assert.equal(rec.commit(), true);
  assert.equal(state.tracks, 0); assert.equal(state.ended, 0);
  socket.message({ type: 'transcript-final', id: 'one', text: 'Ich brauche meinen Stundenplan.' });
  results = state.results.at(-1).results;
  assert.equal(endOfTurnDelay(results[0][0].transcript, { ...results, final: true }), null, 'finalizing audio still blocks submission');
  socket.message({ type: 'finish', text: 'Ich brauche meinen Stundenplan.', segments: [] });
  results = state.results.at(-1).results;
  assert.equal(results.audioPending, false);
  assert.equal(results[0][0].transcript, 'Ich brauche meinen Stundenplan.');
  assert.ok(endOfTurnDelay(results[0][0].transcript, { ...results, final: true }) >= 100);
});

test('one-shot dictation preserves speech resumed while a paused phrase is finalizing', async (t) => {
  const { rec, state } = await recognitionHarness(); t.after(() => rec.abort());
  rec.continuous = false; rec.start(); await tick(); const first = ready();
  sendPackets(state, 4, 0.04);
  first.message({ type: 'transcript-partial', id: 'one', text: 'I need help with' });
  sendPackets(state, 81);
  sendPackets(state, 6, 0.04);
  first.message({ type: 'transcript-final', id: 'one', text: 'I need help with' });
  first.message({ type: 'finish', text: 'I need help with', segments: [] });
  await tick(); const second = ready();
  assert.equal(state.ended, 0); assert.equal(state.tracks, 0);
  second.message({ type: 'transcript-partial', id: 'one', text: 'the exam tomorrow.' });
  sendPackets(state, 45);
  second.message({ type: 'finish', text: 'the exam tomorrow.', segments: [] });
  assert.equal(state.ended, 1); assert.ok(state.tracks > 0);
  assert.deepEqual(state.results.at(-1).results.map((r) => r[0].transcript), ['I need help with', 'the exam tomorrow.']);
});

test('an empty final transcript clears uncertain interim words and keeps continuous listening active', async (t) => {
  const { rec, state } = await recognitionHarness(); t.after(() => rec.abort());
  rec.start(); await tick(); const socket = ready();
  socket.message({ type: 'transcript-partial', id: 'one', text: 'Noise mistaken for a request' });
  rec.commit(); socket.message({ type: 'finish', text: '', segments: [] });
  assert.equal(state.results.at(-1).results.length, 0);
  assert.equal(state.results.at(-1).results.audioPending, false);
  assert.equal(state.ended, 0); assert.equal(state.tracks, 0);
});

test('OpenAI capture releases resources on provider errors, slow connections and cancelled permission', async (t) => {
  const failed = await recognitionHarness(); failed.rec.start(); await tick();
  const bad = Socket.all.at(-1); bad.open(); bad.message({ type: 'error', error: { message: 'upstream details' } });
  assert.deepEqual(failed.state.errors, ['network']); assert.equal(failed.state.closed, 1);
  const slow = await recognitionHarness({ requestSession: () => new Promise(() => {}) }); t.after(() => slow.rec.abort());
  slow.rec.start(); await tick(); sendPackets(slow.state, 201, 0.01);
  assert.deepEqual(slow.state.errors, ['network']); assert.equal(slow.state.closed, 1);
  let release; let stopped = 0;
  const pending = await recognitionHarness({ getUserMedia: () => new Promise((resolve) => { release = resolve; }) });
  pending.rec.start(); pending.rec.abort();
  release({ getTracks: () => [{ stop: () => stopped++ }] }); await tick();
  assert.equal(stopped, 1); assert.equal(pending.state.grants, 0);
});
