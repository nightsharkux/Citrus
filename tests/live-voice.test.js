'use strict';
/** Live voice (GPT-Live through the AI Gateway): the server pass, its access rules, and the browser protocol. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startApp } = require('./helpers');

const PASS = 'vcst_live.fixture-token';

function gateway({ refuse = false } = {}) {
  const state = { grants: [], chats: [] };
  return {
    state,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      if (url === 'https://ai-gateway.vercel.sh/v1/realtime/client-secrets') {
        state.grants.push({ headers: options.headers, body });
        if (refuse) return new Response('{"error":"model not available"}', { status: 403 });
        return Response.json({ token: PASS, expiresAt: Math.floor(Date.now() / 1000) + 60 });
      }
      state.chats.push(body);
      return Response.json({ choices: [{ message: { content: 'Your next lecture is Databases at 10 am in room 2.14 [1].' } }] });
    },
  };
}

async function readyApp(fixture, env = {}) {
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'gateway-fixture-secret', ...env }, fetchImpl: fixture.fetchImpl });
  await app.login('admin');
  await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
  await app.register('stu');
  return app;
}

test('a signed-in user gets a single-use live pass and instructions; the gateway key never leaves the server', async (t) => {
  const fixture = gateway();
  const app = await readyApp(fixture);
  t.after(() => app.close());
  assert.equal((await app.call('anon', 'POST', '/api/assistant/live', {})).status, 401);
  assert.equal((await app.call('stu', 'POST', '/api/assistant/live', {}, { headers: { Origin: 'https://other.invalid' } })).status, 403);
  assert.equal(fixture.state.grants.length, 0);
  assert.equal((await app.call('stu', 'GET', '/api/bootstrap')).body.ai.live, true);

  const r = await app.call('stu', 'POST', '/api/assistant/live', {});
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(fixture.state.grants[0].body, { model: 'openai/gpt-live-1', routeKind: 'live' });
  assert.equal(fixture.state.grants[0].headers.Authorization, 'Bearer gateway-fixture-secret');
  assert.equal(r.body.token, PASS);
  assert.equal(r.body.url, 'wss://ai-gateway.vercel.sh/v1/live/sessions');
  assert.equal(r.body.model, 'openai/gpt-live-1');
  assert.match(r.body.instructions, /live voice conversation/);
  assert.match(r.body.instructions, /Delegate to the app/);
  assert.match(r.body.instructions, /<CONTEXT>/);
  assert.doesNotMatch(JSON.stringify(r.body), /gateway-fixture-secret/);

  // Someone else's conversation thread is not theirs to continue.
  await app.register('other');
  const thread = (await app.call('other', 'POST', '/api/assistant/messages', { prompt: 'Hello' })).body.thread.id;
  assert.equal((await app.call('stu', 'POST', '/api/assistant/live', { thread_id: thread })).status, 404);
  const own = await app.call('other', 'POST', '/api/assistant/live', { thread_id: thread });
  assert.equal(own.status, 200);
  assert.match(own.body.instructions, /Earlier in this conversation/);
});

test('live voice is off without AI, when switched off, and rests after the gateway refuses it', async (t) => {
  const off = await startApp({ env: { AI_GATEWAY_API_KEY: 'k' } });
  t.after(() => off.close());
  await off.register('stu');
  assert.equal((await off.call('stu', 'POST', '/api/assistant/live', {})).status, 503);
  assert.equal((await off.call('stu', 'GET', '/api/bootstrap')).body.ai.live, false);

  const disabled = gateway();
  const app = await readyApp(disabled, { CAMPUS_AI_LIVE_MODEL: 'off' });
  t.after(() => app.close());
  assert.equal((await app.call('stu', 'GET', '/api/bootstrap')).body.ai.live, false);
  assert.equal((await app.call('stu', 'POST', '/api/assistant/live', {})).status, 503);
  assert.equal(disabled.state.grants.length, 0);

  const refusing = gateway({ refuse: true });
  const refused = await readyApp(refusing);
  t.after(() => refused.close());
  assert.equal((await refused.call('stu', 'POST', '/api/assistant/live', {})).status, 503);
  assert.equal((await refused.call('stu', 'GET', '/api/bootstrap')).body.ai.live, false, 'conversations use the standard voice meanwhile');
});

test('a question handed over by live voice carries what Citrus had just said', async (t) => {
  const fixture = gateway();
  const app = await readyApp(fixture);
  t.after(() => app.close());
  const r = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'yes please', mode: 'voice', live_context: 'Shall I add the Databases exam to your calendar?' });
  assert.equal(r.status, 200);
  assert.match(fixture.state.chats.at(-1).messages[0].content, /Shall I add the Databases exam to your calendar\?/);
  await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'Hello', live_context: 'ignored outside voice mode' });
  assert.doesNotMatch(fixture.state.chats.at(-1).messages[0].content, /ignored outside voice mode/);
});

// ---- the browser protocol (public/js/features/live.js), with a stand-in socket and microphone

const loadLive = () => import(pathToFileURL(path.join(__dirname, '../public/js/features/live.js')).href);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function harness(options = {}) {
  const { LiveSession, LIVE_URL } = await loadLive();
  const state = { sockets: [], events: [], ended: [], audio: [], delegations: [], micStopped: 0, packet: null };
  class Socket {
    constructor(url, protocols) {
      Object.assign(this, { url, protocols, readyState: 0, bufferedAmount: 0 });
      state.sockets.push(this);
    }
    send(data) { state.events.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    server(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  }
  const live = new LiveSession({
    requestPass: async () => ({ token: PASS, url: LIVE_URL, model: 'openai/gpt-live-1', instructions: 'Be Citrus.' }),
    Socket,
    capture: async (onPacket) => {
      state.packet = onPacket;
      return { stop: () => { state.micStopped += 1; } };
    },
    onAudio: (delta) => state.audio.push(delta),
    onDelegation: (id, words, said) => state.delegations.push({ id, words, said }),
    onEnd: (reason, { started, trace }) => {
      state.ended.push({ reason, started });
      state.trace = trace;
    },
    ...options,
  });
  return { live, state, LIVE_URL };
}

test('the browser starts a Live session, streams the microphone only once it is ready, and plays the reply', async () => {
  const { live, state, LIVE_URL } = await harness();
  await live.start();
  const socket = state.sockets[0];
  assert.equal(socket.url, LIVE_URL);
  assert.deepEqual(socket.protocols, ['ai-gateway-realtime.v1', `ai-gateway-auth.${PASS}`]);
  socket.open();
  assert.deepEqual(state.events[0], { type: 'session.start', session: { model: 'openai/gpt-live-1', store: false, delegation: { type: 'client' }, audio: { format: { type: 'audio/pcm', rate: 24000 } }, instructions: 'Be Citrus.' } });
  state.packet(new Uint8Array([1, 2, 3, 4]).buffer);
  assert.equal(state.events.length, 1, 'no audio before session.started');
  socket.server({ type: 'session.started' });
  state.packet(new Uint8Array([1, 2, 3, 4]).buffer);
  assert.deepEqual(state.events[1], { type: 'session.input_audio.append', audio: Buffer.from([1, 2, 3, 4]).toString('base64') });
  socket.server({ type: 'session.output_audio.delta', delta: 'AAAA' });
  assert.deepEqual(state.audio, ['AAAA']);
  live.mute(true);
  state.packet(new Uint8Array([5, 6]).buffer);
  assert.deepEqual(state.events.slice(2), [{ type: 'session.input_audio.mute' }], 'muted: no audio is sent');
  live.mute(false);

  live.close();
  assert.equal(state.micStopped, 1);
  assert.equal(state.events.at(-1).type, 'session.close');
  assert.equal(state.ended.length, 0, 'waits for the final usage');
  socket.server({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 42 } });
  assert.deepEqual(state.ended, [{ reason: 'closed', started: true }]);
  assert.equal(live.usage, 42);
});

test('delegations get the words of the current turn and what Citrus said before it; answers go back to be spoken', async () => {
  const { live, state } = await harness();
  await live.start();
  const socket = state.sockets[0];
  socket.open();
  socket.server({ type: 'session.started' });
  socket.server({ type: 'session.input_transcript.delta', delta: 'What is my' });
  socket.server({ type: 'session.input_transcript.delta', delta: ' next lecture?' });
  socket.server({ type: 'session.output_transcript.delta', delta: 'Let me check.' });
  socket.server({ type: 'session.delegation.created', delegation: { id: 'del_1', type: 'delegation', target: 'client' } });
  assert.deepEqual(state.delegations[0], { id: 'del_1', words: 'What is my next lecture?', said: '' });
  live.answer('del_1', 'Databases at 10 am in room 2.14.');
  assert.deepEqual(state.events.at(-1), { type: 'session.commentary.append', delegation_id: 'del_1', content: 'Databases at 10 am in room 2.14.' });

  socket.server({ type: 'session.output_transcript.delta', delta: ' Shall I add a reminder?' });
  socket.server({ type: 'session.input_transcript.delta', delta: 'Yes please.' });
  socket.server({ type: 'session.delegation.created', delegation: { id: 'del_2' } });
  assert.equal(state.delegations[1].words, 'Yes please.');
  assert.match(state.delegations[1].said, /Shall I add a reminder\?/);
  live.answer('del_2', 'x'.repeat(5000));
  assert.equal(state.events.at(-1).content.length, 1800, 'an append stays within the provider limit');
});

test('a session that never starts ends as unavailable, so the standard voice takes over', async () => {
  const refused = await harness({ requestPass: async () => { throw Object.assign(new Error('503'), { status: 503 }); } });
  await refused.live.start();
  assert.deepEqual(refused.state.ended, [{ reason: 'unavailable', started: false }]);

  const forged = await harness({ requestPass: async () => ({ token: PASS, url: 'wss://evil.invalid/live', model: 'x' }) });
  await forged.live.start();
  assert.equal(forged.state.sockets.length, 0, 'never connects anywhere but the gateway');
  assert.equal(forged.state.ended[0].reason, 'unavailable');

  const dropped = await harness();
  await dropped.live.start();
  dropped.state.sockets[0].onclose();
  assert.deepEqual(dropped.state.ended, [{ reason: 'unavailable', started: false }]);
  assert.equal(dropped.state.micStopped, 1, 'the microphone is released');
  assert.equal(dropped.state.trace.reason, 'unavailable');
  assert.equal(dropped.state.trace.opened, false, 'the report says how far it got');

  const blocked = await harness({ capture: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } });
  await blocked.live.start();
  assert.equal(blocked.state.ended[0].reason, 'blocked');

  const lost = await harness();
  await lost.live.start();
  lost.state.sockets[0].open();
  lost.state.sockets[0].server({ type: 'session.started' });
  lost.state.sockets[0].server({ type: 'error', error: { type: 'invalid_request_error', message: 'moderation' } });
  assert.equal(lost.state.ended.length, 0, 'an error during the conversation does not end it');
  lost.state.sockets[0].onclose();
  assert.deepEqual(lost.state.ended, [{ reason: 'lost', started: true }]);
  await tick();
});

test('answers are spoken without citations, links or Markdown', async () => {
  const { spokenAnswer } = await loadLive();
  assert.equal(spokenAnswer('**Databases** is at 10 am [1], see [the timetable](https://example.edu/plan) or https://x.edu/a.'), 'Databases is at 10 am, see the timetable or');
  assert.equal(spokenAnswer(''), '');
});
