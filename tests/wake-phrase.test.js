'use strict';
/** "Hey Campus": misheard greetings wake it at the start of a phrase, ordinary sentences about the campus never do. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);

test('clear greetings wake anywhere in a phrase, with or without a command', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const wake = wakeMatcher('Campus');
  assert.deepEqual(wake.match('Hey Campus, open my schedule'), { rest: 'open my schedule', how: 'greeting' });
  assert.equal(wake.match('hey campus')?.rest, '');
  assert.equal(wake.match('so hey Kampus what is next')?.rest, 'what is next', 'mid-phrase, and the name misheard');
  assert.equal(wake.match('hallo Campus, dunkler Modus')?.rest, 'dunkler Modus');
});

test('"hit campus" and other misheard greetings wake at the start of a phrase', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const wake = wakeMatcher('Campus');
  for (const said of ['hit campus', 'Hit Campus.', 'hit campus open my schedule', 'hate campus what lecture do I have', 'high campus, dark mode', 'he campus new chat']) {
    assert.ok(wake.match(said), `wakes: ${said}`);
  }
  assert.equal(wake.match('hit campus open my schedule').rest, 'open my schedule');
  assert.equal(wake.match('hit campus open my schedule').how, 'misheard');
});

test('ordinary sentences about the campus never wake it', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const wake = wakeMatcher('Campus');
  for (const said of [
    "let's hit campus tomorrow",
    'we should hit campus early',
    'hit campus tomorrow',
    'hit campus at nine',
    'campus is closed on sunday',
    'campus library opens at eight',
    'the campus library is open',
    'I left my bag on campus',
    "campus's new building",
    'okay campus is far from here',
    'Campus life is great',
    'Campus ist heute zu',
  ]) {
    assert.equal(wake.match(said), null, `stays asleep: ${said}`);
  }
});

test('a comma after the name means it is being addressed', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const wake = wakeMatcher('Campus');
  assert.equal(wake.match('Campus, is it raining?')?.rest, 'is it raining?');
  assert.equal(wake.match('Campus open my schedule')?.rest, 'open my schedule');
});

test('half-heard phrases wait for a whole word after a misheard greeting', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const wake = wakeMatcher('Campus');
  // While "hit campus tomorrow" is still being heard, "hit campus t" must not wake.
  assert.equal(wake.ready(wake.match('hit campus t'), false), false);
  assert.equal(wake.ready(wake.match('hit campus'), false), false);
  assert.equal(wake.ready(wake.match('hit campus'), true), true, 'a finished "hit campus" waits for the command');
  assert.equal(wake.ready(wake.match('hit campus open'), false), false, 'the first word may still be growing');
  assert.equal(wake.ready(wake.match('hit campus open my'), false), true);
  assert.equal(wake.ready(wake.match('hey campus'), false), true, 'a clear greeting wakes at once');
});

test('a lecture microphone only takes the bare name with a pause mark', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const lecture = wakeMatcher('Campus', { strict: true });
  assert.equal(lecture.match('Campus explains the next part'), null);
  assert.equal(lecture.match('Campus, explain the last thing I said')?.rest, 'explain the last thing I said');
  assert.equal(lecture.match('hey campus explain the last thing I said')?.rest, 'explain the last thing I said');
});

test('stop works with every way of waking, and other names work the same way', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  assert.ok(wakeMatcher('Campus').isStop('Campus, stop'));
  assert.ok(wakeMatcher('Campus').isStop('hit campus stop'));
  assert.ok(!wakeMatcher('Campus').isStop('Campus, stop the timer and add a note'));
  const max = wakeMatcher('Max');
  assert.equal(max.match('hey Max, what time is it')?.rest, 'what time is it');
  assert.equal(max.match('hit max what time is it')?.rest, 'what time is it');
  assert.equal(max.match('the max is three'), null);
});
