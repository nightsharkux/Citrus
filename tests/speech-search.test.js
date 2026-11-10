'use strict';
/** Natural voices (AI Gateway text to speech) and web search for the assistant, with their fallbacks and switches. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { makeProviders } = require('../src/ai/providers');
const { speechOptions, voiceCatalog } = require('../src/ai/voices');

const AUDIO = Buffer.from('ID3-fake-mp3-bytes');

/** A gateway stand-in: chat completions (streamed or not) and the speech endpoint. */
function gateway({ reply = 'Here is what I found on [Tagesschau](https://www.tagesschau.de/wissen/klima-100.html).', refuseTools = false, refuseSpeech = false } = {}) {
  const state = { chats: [], speech: [] };
  return {
    state,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      if (url === 'https://ai-gateway.vercel.sh/v4/ai/speech-model') {
        state.speech.push({ headers: options.headers, body });
        if (refuseSpeech) return new Response('{"error":"no access"}', { status: 403 });
        return Response.json({ audio: AUDIO.toString('base64'), warnings: [] });
      }
      assert.equal(url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
      state.chats.push(body);
      if (refuseTools && body.tools) return new Response('{"error":"tool not enabled"}', { status: 400 });
      if (body.stream) {
        const chunks = reply.match(/.{1,12}/gs).map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        return new Response(`${chunks.join('')}data: [DONE]\n\n`);
      }
      return Response.json({ choices: [{ message: { content: reply } }] });
    },
  };
}

async function readyApp(fixture, env = {}) {
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', ...env }, fetchImpl: fixture.fetchImpl });
  await app.login('admin');
  assert.equal((await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' })).body.aiEnabled, true);
  await app.register('stu');
  return app;
}

test('voices are checked against the catalog, and German text never goes to an English-only voice', () => {
  assert.equal(speechOptions('openai/tts-1', { voice: 'nova' }).voice, 'nova');
  assert.equal(speechOptions('openai/tts-1', { voice: '<script>' }).voice, 'nova', 'unknown voices fall back to a supported voice');
  assert.equal(speechOptions('openai/tts-1', { voice: 'coral' }).voice, 'nova', 'Realtime-only voices cannot reach the legacy endpoint');
  assert.equal(speechOptions('openai/tts-1', { voice: 'nova', speed: 1.2 }).speed, 1.2);
  assert.equal(speechOptions('openai/tts-1', { voice: 'nova', speed: 1 }).speed, undefined, 'normal speed is not sent');
  assert.match(speechOptions('google/gemini-3.8-flash-tts', {}).instructions, /calm/i, 'Gemini is told how to sound');
  assert.equal(speechOptions('google/gemini-3.8-flash-tts', {}).format, 'wav');
  assert.equal(speechOptions('microsoft/mai-voice-2.1-flash', { voice: 'en-US-Harper', language: 'de' }).voice, 'de-DE-Mia');
  assert.equal(speechOptions('microsoft/mai-voice-2.1-flash', { voice: 'en-US-Harper', language: 'en' }).voice, 'en-US-Harper');
  assert.ok(voiceCatalog('openai/tts-1').voices.length >= 6);
  assert.deepEqual(voiceCatalog('unknown/model').voices, []);
});

test('natural voices: the gateway speech request, caching, quota-free reuse and a 503 when switched off', async () => {
  const fixture = gateway();
  const app = await readyApp(fixture);
  try {
    const info = await app.call('stu', 'GET', '/api/speech');
    assert.equal(info.body.enabled, true);
    assert.equal(info.body.model, 'elevenlabs/eleven-flash-v2.5');
    assert.ok(info.body.voices.some((v) => v.label === 'Bella'));
    assert.equal((await app.call('stu', 'GET', '/api/bootstrap')).body.ai.speech, true);

    const res = await app.call('stu', 'POST', '/api/speech', { text: 'Hallo! Die Bibliothek ist offen.', voice: 'nova', speed: 1.1, lang: 'de' }, { raw: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), AUDIO);
    const sent = fixture.state.speech[0];
    assert.equal(sent.headers['ai-model-id'], 'elevenlabs/eleven-flash-v2.5');
    assert.equal(sent.headers['ai-speech-model-specification-version'], '4');
    assert.equal(sent.headers.Authorization, 'Bearer fixture-key');
    assert.deepEqual(sent.body, { text: 'Hallo. Die Bibliothek ist offen.', outputFormat: 'mp3', voice: 'hpp4J3VqNfWAUOO0d1Us', speed: 1.1 });

    await app.call('stu', 'POST', '/api/speech', { text: 'Hallo. Die Bibliothek ist offen.', voice: 'nova', speed: 1.1, lang: 'de' }, { raw: true });
    assert.equal(fixture.state.speech.length, 1, 'the same sentence in the same voice comes from the cache');

    assert.equal((await app.call('stu', 'POST', '/api/speech', { text: '' })).status, 400);
    assert.equal((await app.call('stu', 'POST', '/api/speech', { text: 'Hi', speed: 9 })).status, 400);
    assert.equal((await app.call('stu', 'POST', '/api/speech', { text: 'Hi', lang: 'fr' })).status, 400);
    assert.equal((await app.call('anon', 'POST', '/api/speech', { text: 'Hi' })).status, 401, 'signed-out visitors cannot spend speech');
    assert.equal((await app.call('anon', 'GET', '/api/speech')).status, 401);

    // Students cannot change the switch; the administrator can.
    assert.equal((await app.call('stu', 'PATCH', '/api/ai/settings', { speech: false })).status, 403);
    const off = await app.call('admin', 'PATCH', '/api/ai/settings', { speech: false });
    assert.equal(off.body.speech, false);
    assert.equal(off.body.speechAllowed, false);
    assert.equal((await app.call('stu', 'GET', '/api/speech')).body.enabled, false);
    const refused = await app.call('stu', 'POST', '/api/speech', { text: 'Something new' });
    assert.equal(refused.status, 503, 'the browser falls back to its own voices');
    assert.equal((await app.call('admin', 'PATCH', '/api/ai/settings', { speech: 'yes' })).status, 400);
    assert.equal((await app.call('admin', 'PATCH', '/api/ai/settings', {})).status, 400);
  } finally {
    await app.close();
  }
});

test('natural voices rest after the gateway refuses them, and CAMPUS_AI_SPEECH_MODEL=off turns them off', async () => {
  const fixture = gateway({ refuseSpeech: true });
  const app = await readyApp(fixture);
  try {
    assert.equal((await app.call('stu', 'POST', '/api/speech', { text: 'Hello there.' })).status, 503);
    assert.equal((await app.call('stu', 'GET', '/api/speech')).body.enabled, false, 'resting: browsers use their own voices');
    assert.equal(fixture.state.speech.length, 1);
  } finally {
    await app.close();
  }
  const offApp = await readyApp(gateway(), { CAMPUS_AI_SPEECH_MODEL: 'off' });
  try {
    assert.equal((await offApp.call('stu', 'GET', '/api/speech')).body.enabled, false);
  } finally {
    await offApp.close();
  }
});

test('web search: the gateway tool is attached, linked pages become sources, and the globe button forces a search', async () => {
  const fixture = gateway();
  const app = await readyApp(fixture);
  try {
    const auto = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'What is new in climate research this week?' });
    assert.equal(auto.status, 200);
    let sent = fixture.state.chats.at(-1);
    assert.deepEqual(sent.tools, [{ type: 'vercel:perplexity_search', config: { max_results: 6 } }]);
    assert.equal(sent.tool_choice, 'auto');
    assert.match(sent.messages[0].content, /You can search the web/);
    assert.match(sent.messages[0].content, /never invent or guess a URL/);
    const web = auto.body.message.sources.find((s) => s.web);
    assert.deepEqual({ ...web, n: undefined }, { n: undefined, title: 'Tagesschau', url: 'https://www.tagesschau.de/wissen/klima-100.html', web: true, site: 'tagesschau.de' });

    const forced = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'Look up the weather in Amberg', web: 'on' }, { headers: { accept: 'text/event-stream' }, raw: true });
    const events = await forced.text();
    assert.match(events, /event: searching/);
    assert.equal(fixture.state.chats.at(-1).tool_choice, 'required');
    assert.match(fixture.state.chats.at(-1).messages[0].content, /search before you answer/);

    await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'Just explain photosynthesis', web: 'off' });
    assert.equal(fixture.state.chats.at(-1).tools, undefined, 'off means no search');
    assert.equal((await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'Hi', web: 'always' })).status, 400);

    await app.call('admin', 'PATCH', '/api/ai/settings', { web_search: false });
    await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'Any news?', web: 'on' });
    sent = fixture.state.chats.at(-1);
    assert.equal(sent.tools, undefined, 'the institution switch wins over the button');
    assert.doesNotMatch(sent.messages[0].content, /You can search the web/);
  } finally {
    await app.close();
  }
});

test('ordinary chat, explanations and local schedule questions avoid the web-search round trip', async (t) => {
  const fixture = gateway({ reply: 'A local answer.' });
  const app = await readyApp(fixture); t.after(() => app.close());
  for (const prompt of ['Hello', 'Explain the quadratic formula', 'Explain binary search', 'Erkläre die binäre Suche', 'Was steht heute in meinem Stundenplan?', 'Add a study session tomorrow at 4 pm']) {
    const result = await app.call('stu', 'POST', '/api/assistant/messages', { prompt, mode: 'voice' });
    assert.equal(result.status, 200);
    assert.equal(fixture.state.chats.at(-1).tools, undefined);
  }
  await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'Explain fractions', web: 'on' });
  assert.equal(fixture.state.chats.at(-1).tool_choice, 'required');
  await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'Search for the university website' });
  assert.equal(fixture.state.chats.at(-1).tool_choice, 'auto');
});

test('a gateway that refuses the search tool still answers, without search, and rests it', async () => {
  const fixture = gateway({ refuseTools: true, reply: 'An answer without the web.' });
  const app = await readyApp(fixture);
  try {
    const first = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'Latest news?' });
    assert.equal(first.status, 200);
    assert.equal(first.body.message.content, 'An answer without the web.');
    assert.equal(fixture.state.chats.length, 2, 'tried with the tool, then without');
    assert.ok(fixture.state.chats[0].tools && !fixture.state.chats[1].tools);
    await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'And now?' });
    assert.equal(fixture.state.chats.length, 3, 'resting: no second refused attempt');
    assert.equal(fixture.state.chats[2].tools, undefined);
    assert.equal((await app.call('stu', 'GET', '/api/bootstrap')).body.ai.webSearch, false);
  } finally {
    await app.close();
  }
});

test('a spoken question uses the short-thinking voice model; typed ones keep the configured level', async () => {
  const requests = [];
  const providers = makeProviders({
    env: { AI_GATEWAY_API_KEY: 'key', CAMPUS_AI_DEFAULT_MODEL: 'openai/gpt-6.1-terra/high' },
    fetchImpl: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: 'Yes.' } }] });
    },
  });
  await providers.generate('gateway', 'System', 'Hello', [], { task: 'voice' });
  await providers.generate('gateway', 'System', 'Hello', [], { task: 'chat' });
  assert.deepEqual(requests[0].reasoning, { effort: 'low' });
  assert.deepEqual(requests[1].reasoning, { effort: 'high' });
  const plain = makeProviders({ env: { AI_GATEWAY_API_KEY: 'key', CAMPUS_AI_DEFAULT_MODEL: 'openai/gpt-6-mini' }, fetchImpl: async (url, options) => { requests.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: 'Yes.' } }] }); } });
  await plain.generate('gateway', 'System', 'Hello', [], { task: 'voice' });
  assert.equal(requests.at(-1).reasoning, undefined, 'a model without a reasoning level is left alone');
});

test('a refused piece of text does not turn natural voices off; a refused account does', async () => {
  let status = 400;
  const providers = makeProviders({
    env: { AI_GATEWAY_API_KEY: 'fixture-key' },
    fetchImpl: async () => new Response('{"error":"refused"}', { status }),
  });
  const say = () => providers.speech('gateway', 'Hello there.', { voice: 'coral', format: 'mp3' });
  await assert.rejects(say(), { status: 503 });
  assert.ok(providers.speechModel('gateway'), 'one bad request leaves voices on for everyone');
  status = 500;
  await assert.rejects(say(), { status: 503 });
  assert.ok(providers.speechModel('gateway'), 'a gateway hiccup leaves voices on');
  status = 403;
  await assert.rejects(say(), { status: 503 });
  assert.equal(providers.speechModel('gateway'), null, 'no access rests voices for a while');
});
