'use strict';
/**
 * Lookups (the web, attached files, the university's documents) go to the fast Gemini search model; explanations
 * and actions stay with the chat model. Every answer is written for a student (or member) of the university.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { needsLookup } = require('../src/ai/latency');
const { assistantPrompt, livePrompt } = require('../src/ai/prompts');

function gateway() {
  const requests = [];
  return {
    requests,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"The exam office is in room A1.12 [1]."}}]}\n\ndata: [DONE]\n\n');
      return Response.json({ choices: [{ message: { content: 'The exam office is in room A1.12 [1].' } }] });
    },
  };
}

async function readyApp(fixture, env = {}) {
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_RATE_PER_MINUTE: '1000', ...env }, fetchImpl: fixture.fetchImpl });
  await app.login('admin');
  await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
  const added = await app.call('admin', 'POST', '/api/knowledge', { title: 'Examination office', content: 'The examination office (Prüfungsamt) is in room A1.12 in Amberg. Exam registration runs through Primuss.', category: 'Services', source_url: 'https://www.oth-aw.de/' });
  assert.ok(added.status < 300, 'knowledge entry added');
  await app.register('stu');
  return app;
}

test('lookups use Gemini; explanations, actions and general chat use the chat model', async (t) => {
  const fixture = gateway();
  const app = await readyApp(fixture);
  t.after(() => app.close());
  const ask = async (prompt, extra = {}) => {
    const r = await app.call('stu', 'POST', '/api/assistant/messages', { prompt, ...extra });
    assert.equal(r.status, 200);
    return fixture.requests.at(-1);
  };
  let sent = await ask('Where is the examination office and when do I register for exams?');
  assert.equal(sent.model, 'google/gemini-3.8-flash');
  assert.deepEqual(sent.reasoning, { effort: 'low' });
  assert.deepEqual(sent.provider, { sort: 'ttft' });

  sent = await ask('Explain how the exam registration deadline is calculated.');
  assert.equal(sent.model, 'openai/gpt-6.1-sol', 'explanations stay with the chat model');
  sent = await ask('Add a reminder for the exam registration tomorrow.');
  assert.equal(sent.model, 'openai/gpt-6.1-sol', 'actions stay with the chat model');
  sent = await ask('Search the web for the latest news about the exam office.', { web: 'on' });
  assert.equal(sent.model, 'google/gemini-3.8-flash', 'web searches go to Gemini');
  assert.equal(sent.tools?.[0]?.type, 'vercel:perplexity_search');
  sent = await ask('Wo ist das Prüfungsamt?', { mode: 'voice' });
  assert.equal(sent.model, 'google/gemini-3.8-flash', 'spoken lookups too');
  assert.deepEqual(sent.reasoning, { effort: 'low' });
  assert.match(sent.messages[0].content, /a student at/, 'the system prompt sets the perspective');
});

test('CAMPUS_AI_SEARCH_MODEL chooses another search model, or "off" keeps lookups on the chat model', async (t) => {
  const off = gateway();
  const app = await readyApp(off, { CAMPUS_AI_SEARCH_MODEL: 'off' });
  t.after(() => app.close());
  await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'Where is the examination office?' });
  assert.equal(off.requests.at(-1).model, 'openai/gpt-6.1-sol');

  const other = gateway();
  const custom = await readyApp(other, { CAMPUS_AI_SEARCH_MODEL: 'google/gemini-3.5-flash-lite' });
  t.after(() => custom.close());
  await custom.call('stu', 'POST', '/api/assistant/messages', { prompt: 'Where is the examination office?' });
  assert.equal(other.requests.at(-1).model, 'google/gemini-3.5-flash-lite');
  assert.equal(other.requests.at(-1).reasoning, undefined);
  assert.equal((await custom.call('admin', 'GET', '/api/ai/settings')).body.searchModel, 'google/gemini-3.5-flash-lite');
});

test('which questions count as lookups', () => {
  for (const q of ['When is my next lecture?', 'Wo ist das Prüfungsamt?', 'Wann endet die Vorlesungszeit?', 'Who is my programme leader?', 'How do I register for the exam?', 'Welche Module hat das dritte Semester?']) {
    assert.equal(needsLookup(q), true, q);
  }
  for (const q of ['Explain the chain rule', 'Erklär mir Rekursion', 'Remind me about the exam tomorrow', 'Trag die Klausur in meinen Kalender ein', 'Hi, how are you?', 'Write an email to my professor', 'Quiz me on databases']) {
    assert.equal(needsLookup(q), false, q);
  }
});

test('answers are written for someone at the university, without saying so', () => {
  const base = { site: { concept: true }, assistantName: 'Citrus', context: '', sources: [] };
  const student = assistantPrompt({ ...base, user: { institution: 'OTH Amberg-Weiden — Independent Concept', name: 'Ana Person', role: 'student' } });
  assert.match(student, /Treat every question as coming from a student at OTH Amberg-Weiden, unless they say otherwise/);
  assert.match(student, /campuses in Amberg and Weiden/);
  assert.match(student, /Never mention that you are assuming this/);
  const lecturer = assistantPrompt({ ...base, user: { institution: 'OTH Amberg-Weiden — Independent Concept', name: 'Ben Person', role: 'lecturer' } });
  assert.match(lecturer, /coming from a lecturer at OTH Amberg-Weiden/);
  const elsewhere = assistantPrompt({ ...base, user: { institution: 'Example University', name: 'Cy Person', role: 'student' } });
  assert.match(elsewhere, /a student at Example University/);
  assert.doesNotMatch(elsewhere, /Amberg/);
  const live = livePrompt({ ...base, user: { institution: 'OTH Amberg-Weiden — Independent Concept', name: 'Ana Person', role: 'student' } });
  assert.match(live, /a student at OTH Amberg-Weiden/);
});

test('a live voice conversation that stopped is reported to the server log, without words or audio', async (t) => {
  const fixture = gateway();
  const app = await readyApp(fixture);
  t.after(() => app.close());
  assert.equal((await app.call('anon', 'POST', '/api/assistant/live/trouble', {})).status, 401);
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    const r = await app.call('stu', 'POST', '/api/assistant/live/trouble', {
      reason: 'unavailable', opened: true, ms: 812, sent: 0, closeCode: 1008, closeReason: 'model not enabled\nfor team',
      events: { error: 1 }, error: { type: 'invalid_request_error', code: 'model_not_available', message: 'GPT-Live is not enabled' }, transcript: 'private words',
    });
    assert.equal(r.status, 200);
  } finally {
    console.warn = warn;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /live voice ended/);
  assert.match(lines[0], /"closeCode":1008/);
  assert.match(lines[0], /model_not_available/);
  assert.doesNotMatch(lines[0], /private words/);
  assert.doesNotMatch(lines[0], /\n/);
});
