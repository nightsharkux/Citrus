'use strict';
/** Hands-free voice conversation: turn-taking, echo and interruptions, spoken control phrases, and the voice answer mode. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startApp } = require('./helpers');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);

test('a turn ends after a pause that depends on how the sentence ends', async () => {
  const { endOfTurnDelay } = await load('features/turns.js');
  assert.equal(endOfTurnDelay(''), null, 'nothing said, nothing to send');
  assert.equal(endOfTurnDelay('  '), null);
  const done = endOfTurnDelay('what is on my schedule tomorrow');
  const going = endOfTurnDelay('what is on my schedule for');
  assert.ok(going > done, 'a sentence ending in "for" is still going');
  assert.ok(endOfTurnDelay('so I was thinking um') > done, 'filler words wait longer');
  assert.ok(endOfTurnDelay('what is on my schedule tomorrow', { final: true }) < done, 'a phrase the speech service closed needs less waiting');
  assert.ok(endOfTurnDelay('yes', { final: true }) < endOfTurnDelay('what is on my schedule tomorrow', { final: true }), 'a short answer is complete');
  assert.ok(endOfTurnDelay('Tuesday') > endOfTurnDelay('yes'), 'a single word that is not a reply may be followed by more');
});

test('Campus hearing its own voice is not mistaken for the user', async () => {
  const { isEcho, isInterruption } = await load('features/turns.js');
  const spoken = 'The library opens at eight in the morning and closes at ten in the evening. Want me to add a study session?';
  assert.equal(isEcho('the library opens at eight in the morning', spoken), true);
  assert.equal(isEcho('closes at 10 in the evening', spoken), true, 'one misheard word is still an echo');
  assert.equal(isInterruption('the library opens at eight in the morning', spoken), false);
  assert.equal(isInterruption('the library opens at 8 in the mourning', spoken, { final: true }), false, 'a couple of misheard words are still an echo');
  assert.equal(isEcho('no I meant the gym on Tuesday', spoken), false);

  assert.equal(isInterruption('actually what about Tuesday instead', spoken), true, 'new words while Campus talks');
  assert.equal(isInterruption('wait', spoken), true, 'a stop word interrupts at once');
  assert.equal(isInterruption('Campus, stop.', spoken), true);
  assert.equal(isInterruption('no thanks', spoken), false, 'two words in flight are not enough yet');
  assert.equal(isInterruption('no thanks', spoken, { final: true }), true, 'but they are once the phrase is complete');
  assert.equal(isInterruption('wait', 'Wait for the bus at the main gate.'), false, 'a stop word Campus just said is an echo');
  assert.equal(isInterruption('', spoken), false);
});

test('spoken phrases end the conversation or interrupt, and questions pass through', async () => {
  const { conversationCommand } = await load('features/turns.js');
  for (const text of ['Goodbye', 'okay thanks bye', 'That’s all for now.', 'stop listening', 'end the conversation', 'Bye Campus', 'Tschüss']) {
    assert.equal(conversationCommand(text), 'end', text);
  }
  for (const text of ['Stop.', 'wait a second', 'never mind', 'hold on', 'Campus, stop']) {
    assert.equal(conversationCommand(text), 'interrupt', text);
  }
  for (const text of ['thanks', 'what is a good bye week', 'stop the semester clock from ticking', 'when does the library close', '']) {
    assert.equal(conversationCommand(text), null, text);
  }
});

test('streamed answers are spoken sentence by sentence, never inside formulas or code', async () => {
  const { speakBoundary } = await load('features/turns.js');
  const text = 'Here is the first full sentence of it. And then';
  assert.equal(speakBoundary(text), text.indexOf('. And') + 1);
  assert.equal(speakBoundary('Sure. Let me check'), 5, 'a short first sentence is said at once');
  assert.equal(speakBoundary('1. First you need to read the question'), -1, 'a list number is not the end of a sentence');
  assert.equal(speakBoundary('$$x = 1. y = 2$$'), -1, 'no break inside display maths');
  assert.equal(speakBoundary('Version 3.5 is'), -1, 'a decimal point is not a full stop');
  assert.equal(speakBoundary('Almost done', true), 'Almost done'.length, 'the rest is spoken at the end');
  assert.equal(speakBoundary('The answer is 42.'), -1, 'a full stop at the very end may still be a decimal');
  assert.equal(speakBoundary('The answer is 42.', true), 'The answer is 42.'.length);
});

test('"let’s talk" opens a conversation only where one can start, and "open chat" still opens the assistant', async () => {
  const { matchCommand } = await load('features/commands.js');
  const calls = [];
  const ctx = { role: 'student', navigate: (p) => calls.push(['go', p]), setTheme() {}, stop() {}, stopListening() {}, talk: () => calls.push(['talk']) };
  for (const text of ['Let’s talk', 'talk to me', 'start a conversation', 'voice mode']) {
    calls.length = 0;
    matchCommand(text, ctx)?.run();
    assert.deepEqual(calls, [['talk']], text);
  }
  calls.length = 0;
  matchCommand('open chat', ctx).run();
  assert.deepEqual(calls, [['go', '/assistant']]);
  assert.equal(matchCommand('let’s talk', { ...ctx, talk: undefined }), null, 'without a conversation it goes to the assistant as a question');
  assert.equal(matchCommand('start a new conversation', ctx).say, 'New conversation');
});

/** Gateway fixture in the production request format, without external calls. */
function mockGateway(reply) {
  const state = { last: null };
  return {
    state,
    async fetchImpl(url, options) {
      state.last = JSON.parse(options.body);
      if (state.last.stream) {
        const chunks = reply.split(' ').map((word) => `data: ${JSON.stringify({ choices: [{ delta: { content: `${word} ` } }] })}\n\n`);
        return new Response(`${chunks.join('')}data: [DONE]\n\n`);
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    },
  };
}

test('voice mode asks for short spoken answers and keeps threads private', async () => {
  const gateway = mockGateway('The library is open until ten tonight.');
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key' }, fetchImpl: gateway.fetchImpl });
  try {
    await app.login('admin');
    assert.equal((await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' })).body.aiEnabled, true);
    await app.register('stu');

    const spoken = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'when does the library close', mode: 'voice' });
    assert.equal(spoken.status, 200);
    assert.match(spoken.body.message.content, /open until ten/);
    let system = gateway.state.last.messages[0].content;
    assert.match(system, /live voice conversation/);
    assert.match(system, /Never use Markdown/);
    assert.doesNotMatch(system, /write like a clear textbook/, 'the textbook format is left out');
    assert.match(system, /\[action: NAME/, 'actions still work by voice');

    const threadId = spoken.body.thread.id;
    const streamed = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'and tomorrow', thread_id: threadId, mode: 'voice' }, { headers: { accept: 'text/event-stream' }, raw: true });
    assert.equal(streamed.status, 200);
    assert.match(await streamed.text(), /event: done/);
    assert.equal(gateway.state.last.messages.at(-2).role, 'assistant', 'a spoken follow-up has the thread’s history');

    const typed = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'when does the library close' });
    assert.equal(typed.status, 200);
    system = gateway.state.last.messages[0].content;
    assert.match(system, /write like a clear textbook/);
    assert.doesNotMatch(system, /live voice conversation/, 'typed questions keep the normal format');

    const bad = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'hello', mode: 'shout' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Mode/);

    await app.register('other');
    assert.equal((await app.call('other', 'POST', '/api/assistant/messages', { prompt: 'what did they ask', thread_id: threadId, mode: 'voice' })).status, 404, 'no speaking into someone else’s thread');
    assert.equal((await app.call('anon', 'POST', '/api/assistant/messages', { prompt: 'hello', mode: 'voice' })).status, 401);
    const detail = await app.call('stu', 'GET', `/api/assistant/threads/${threadId}`);
    assert.equal(detail.body.messages.length, 4, 'the spoken exchange is saved in the thread');
  } finally {
    await app.close();
  }
});
