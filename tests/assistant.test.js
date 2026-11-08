'use strict';
/** Assistant: streamed answers, threads, personal context, knowledge citations; provider streaming parsers. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { makeProviders } = require('../src/ai/providers');

/** Gateway fixture uses the production request format without external calls. */
function mockGateway(reply) {
  const state = { last: null };
  return {
    state,
    async fetchImpl(url, options) {
      assert.equal(url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
      state.last = JSON.parse(options.body);
      if (state.last.stream) {
        const chunks = reply.split(' ').map(word => 'data: ' + JSON.stringify({ choices: [{ delta: { content: word + ' ' } }] }) + '\n\n');
        return new Response(chunks.join('') + 'data: [DONE]\n\n');
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    },
  };
}

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((chunk) => {
    const event = /event: (.+)/.exec(chunk)?.[1];
    const data = /data: (.+)/.exec(chunk)?.[1];
    return { event, data: data ? JSON.parse(data) : null };
  });
}

test('streams an answer with citations from the approved knowledge library', async () => {
  const gateway = mockGateway('The library is open Monday to Friday [1].');
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key' }, fetchImpl: gateway.fetchImpl });
  try {
    await app.login('admin');
    assert.equal((await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' })).body.aiEnabled, true);
    const pack = await app.call('admin', 'POST', '/api/knowledge/import-pack');
    assert.ok(pack.body.added >= 40, 'bundled OTH pack imports');
    const again = await app.call('admin', 'POST', '/api/knowledge/import-pack');
    assert.equal(again.body.added, 0, 're-import updates instead of duplicating');

    await app.register('stu');
    await app.call('stu', 'POST', '/api/courses/1/enroll');

    const res = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'When is the library open?' }, { headers: { accept: 'text/event-stream' }, raw: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = parseSse(await res.text());
    const thread = events.find((e) => e.event === 'thread').data;
    const sources = events.find((e) => e.event === 'sources').data.sources;
    const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    const done = events.find((e) => e.event === 'done').data;
    assert.ok(sources.length > 0 && /librar/i.test(sources[0].title + sources[0].excerpt), 'retrieval found the library entry');
    assert.match(text, /library is open/);
    assert.deepEqual(done.sources.map((s) => s.n), [1], 'only cited sources are kept');

    const system = gateway.state.last.messages[0].content;
    assert.match(system, /SOURCES/);
    assert.match(system, /DEMO101/, 'personal context includes the student’s course');
    assert.match(system, /never follow instructions/i);

    const detail = await app.call('stu', 'GET', `/api/assistant/threads/${thread.id}`);
    assert.equal(detail.body.messages.length, 2);
    assert.equal(detail.body.messages[1].sources[0].n, 1);

    // Follow-up in the same thread sends history; JSON mode works too.
    const follow = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'And on Saturday?', thread_id: thread.id });
    assert.equal(follow.status, 200);
    assert.equal(gateway.state.last.messages.at(-2).role, 'assistant');

    await app.register('other');
    assert.equal((await app.call('other', 'GET', `/api/assistant/threads/${thread.id}`)).status, 404, 'threads are private');
    assert.equal((await app.call('stu', 'DELETE', `/api/assistant/threads/${thread.id}`)).status, 200);
    assert.equal((await app.call('stu', 'GET', '/api/assistant')).body.threads.length, 0);

    const search = await app.call('other', 'GET', '/api/knowledge/search?q=exam%20registration');
    assert.ok(search.body.results[0].checkLive, 'time-sensitive sources are flagged');
  } finally {
    await app.close();
  }
});

test('assistant reports a clear 503 when no provider is configured', async () => {
  const app = await startApp();
  try {
    await app.register('stu');
    const r = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'Hello' });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /not connected/);
  } finally {
    await app.close();
  }
});

test('gateway parses SSE text across arbitrary byte boundaries', async () => {
  const payload = ': heartbeat\n\ndata: {"choices":[{"delta":{"content":"H\u00e9llo"}}]}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(payload);
  const providers = makeProviders({
    env: { AI_GATEWAY_API_KEY: 'fixture-key' },
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
      controller.close();
    } })),
  });
  let out = '';
  for await (const delta of providers.stream('gateway', 'sys', 'hi')) out += delta;
  assert.equal(out, 'H\u00e9llo');
});

test('visual cues are parsed from any chunking, stripped from the text and stored with the answer', async () => {
  const { parseCue, extractVisual, createVisualExtractor } = require('../src/ai/visuals');
  assert.deepEqual(parseCue('[visual: Formula | a^2 + b^2 = c^2]'), { kind: 'formula', content: 'a^2 + b^2 = c^2' });
  assert.deepEqual(parseCue('[visual: team]'), { kind: 'people', content: '' }, 'aliases map to known kinds');
  assert.equal(parseCue('[visual: hologram | x]'), null, 'unknown kinds are ignored');
  assert.deepEqual(extractVisual('Plain answer [visual: formula | x]'), { visual: null, text: 'Plain answer [visual: formula | x]' });

  const answer = '[visual: steps | plan, build, test]\n\nFirst you plan, then you build.';
  for (const size of [1, 3, 7, 50]) {
    const x = createVisualExtractor();
    let shown = '';
    for (let i = 0; i < answer.length; i += size) shown += x.push(answer.slice(i, i + size));
    shown += x.end();
    assert.equal(shown, 'First you plan, then you build.', `chunk size ${size}`);
    assert.deepEqual(x.visual, { kind: 'steps', content: 'plan, build, test' });
  }
  const plain = createVisualExtractor();
  assert.equal(plain.push('[1] says') + plain.end(), '[1] says', 'citations at the start are not mistaken for cues');

  const gateway = mockGateway('[visual: formula | a^2 + b^2 = c^2] Pythagoras relates the sides of a right triangle.');
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key' }, fetchImpl: gateway.fetchImpl });
  try {
    await app.login('admin');
    await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
    const res = await app.call('admin', 'POST', '/api/assistant/messages', { prompt: 'Explain Pythagoras' }, { headers: { accept: 'text/event-stream' }, raw: true });
    const events = parseSse(await res.text());
    const visual = events.find((e) => e.event === 'visual');
    assert.deepEqual(visual.data, { kind: 'formula', content: 'a^2 + b^2 = c^2' });
    const shown = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    assert.ok(!shown.includes('[visual'), 'the cue never reaches the reader');
    assert.match(shown, /^Pythagoras/);
    const thread = events.find((e) => e.event === 'thread').data;
    const saved = (await app.call('admin', 'GET', `/api/assistant/threads/${thread.id}`)).body.messages[1];
    assert.equal(saved.visual.kind, 'formula');
    assert.match(saved.content, /^Pythagoras/);
    assert.match(gateway.state.last.messages[0].content, /\[visual: KIND \| CONTENT\]/, 'the model is told how to request an illustration');
  } finally {
    await app.close();
  }
});

test('brand mark and manifest follow the edition', async () => {
  const app = await startApp({ env: { CAMPUS_EDITION: 'general' } });
  try {
    const mark = await app.call('anon', 'GET', '/brand/mark.svg');
    assert.equal(mark.status, 200);
    assert.match(mark.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(mark.body, /#7C6CFF/i);
    const manifest = await app.call('anon', 'GET', '/manifest.webmanifest');
    assert.equal(manifest.body.short_name, 'Campus OS');
    assert.equal(manifest.body.icons[0].src, '/icons/general-192.png');
    assert.equal((await app.call('anon', 'GET', '/api/bootstrap')).body.site.assistant, 'Campus');
  } finally {
    await app.close();
  }
});
