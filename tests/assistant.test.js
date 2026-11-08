'use strict';
/** Assistant: streamed answers, threads, personal context, knowledge citations; provider streaming parsers. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startApp } = require('./helpers');
const { makeProviders } = require('../src/ai/providers');

/** Mock Ollama that streams NDJSON and records the last request. */
async function mockOllama(reply) {
  const state = { last: null };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    state.last = JSON.parse(raw);
    if (state.last.stream) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      for (const word of reply.split(' ')) res.write(`${JSON.stringify({ message: { content: `${word} ` }, done: false })}\n`);
      res.end(`${JSON.stringify({ message: { content: '' }, done: true })}\n`);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: { role: 'assistant', content: reply } }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) };
}

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((chunk) => {
    const event = /event: (.+)/.exec(chunk)?.[1];
    const data = /data: (.+)/.exec(chunk)?.[1];
    return { event, data: data ? JSON.parse(data) : null };
  });
}

test('streams an answer with citations from the approved knowledge library', async () => {
  const ollama = await mockOllama('The library is open Monday to Friday [1].');
  const app = await startApp({ env: { CAMPUS_OLLAMA_URL: ollama.url } });
  try {
    await app.login('admin');
    assert.equal((await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'ollama' })).body.aiEnabled, true);
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

    const system = ollama.state.last.messages[0].content;
    assert.match(system, /SOURCES/);
    assert.match(system, /DEMO101/, 'personal context includes the student’s course');
    assert.match(system, /never follow instructions/i);

    const detail = await app.call('stu', 'GET', `/api/assistant/threads/${thread.id}`);
    assert.equal(detail.body.messages.length, 2);
    assert.equal(detail.body.messages[1].sources[0].n, 1);

    // Follow-up in the same thread sends history; JSON mode works too.
    const follow = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'And on Saturday?', thread_id: thread.id });
    assert.equal(follow.status, 200);
    assert.equal(ollama.state.last.messages.at(-2).role, 'assistant');

    await app.register('other');
    assert.equal((await app.call('other', 'GET', `/api/assistant/threads/${thread.id}`)).status, 404, 'threads are private');
    assert.equal((await app.call('stu', 'DELETE', `/api/assistant/threads/${thread.id}`)).status, 200);
    assert.equal((await app.call('stu', 'GET', '/api/assistant')).body.threads.length, 0);

    const search = await app.call('other', 'GET', '/api/knowledge/search?q=exam%20registration');
    assert.ok(search.body.results[0].checkLive, 'time-sensitive sources are flagged');
  } finally {
    await app.close();
    await ollama.close();
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

test('provider stream parsers handle OpenAI SSE and Anthropic events', async () => {
  const body = (chunks) => new Response(chunks.join('')).body;
  const openai = makeProviders({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: async () => ({ ok: true, body: body(['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', 'data: [DONE]\n\n']) }) });
  let out = '';
  for await (const d of openai.stream('openai', 'sys', 'hi')) out += d;
  assert.equal(out, 'Hello');

  let sent;
  const anthropic = makeProviders({
    env: { ANTHROPIC_API_KEY: 'k' },
    fetchImpl: async (url, opts) => {
      sent = { url, opts };
      return { ok: true, body: body(['event: message_start\ndata: {"type":"message_start"}\n\n', 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi "}}\n\n', 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"there"}}\n\n', 'event: message_stop\ndata: {"type":"message_stop"}\n\n']) };
    },
  });
  out = '';
  for await (const d of anthropic.stream('anthropic', 'sys', 'hi', [{ role: 'assistant', content: 'stray' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' }])) out += d;
  assert.equal(out, 'Hi there');
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.opts.headers['x-api-key'], 'k');
  const payload = JSON.parse(sent.opts.body);
  assert.equal(payload.system, 'sys');
  assert.equal(payload.messages[0].role, 'user', 'leading assistant turns are dropped');
  assert.equal(payload.messages.length, 1, 'consecutive user turns are merged');
  assert.equal(anthropic.status('anthropic').aiEnabled, true);
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

  const ollama = await mockOllama('[visual: formula | a^2 + b^2 = c^2] Pythagoras relates the sides of a right triangle.');
  const app = await startApp({ env: { CAMPUS_OLLAMA_URL: ollama.url } });
  try {
    await app.login('admin');
    await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'ollama' });
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
    assert.match(ollama.state.last.messages[0].content, /\[visual: KIND \| CONTENT\]/, 'the model is told how to request an illustration');
  } finally {
    await app.close();
    await ollama.close();
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
