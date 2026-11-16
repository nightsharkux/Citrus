'use strict';
/** "Hey Citrus": misheard greetings wake it at the start of a phrase, ordinary sentences about the campus never do. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);

test('clear greetings wake anywhere in a phrase, with or without a command', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const wake = wakeMatcher('Citrus');
  assert.deepEqual(wake.match('Hey Citrus, open my schedule'), { rest: 'open my schedule', how: 'greeting' });
  assert.equal(wake.match('hey citrus')?.rest, '');
  assert.equal(wake.match('so hey Sitrus what is next')?.rest, 'what is next', 'mid-phrase, and the name misheard');
  assert.equal(wake.match('hallo Citrus, dunkler Modus')?.rest, 'dunkler Modus');
});

test('"hit citrus" and other misheard greetings wake at the start of a phrase', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const wake = wakeMatcher('Citrus');
  for (const said of ['hit citrus', 'Hit Citrus.', 'hit citrus open my schedule', 'hate citrus what lecture do I have', 'high citrus, dark mode', 'he citrus new chat']) {
    assert.ok(wake.match(said), `wakes: ${said}`);
  }
  assert.equal(wake.match('hit citrus open my schedule').rest, 'open my schedule');
  assert.equal(wake.match('hit citrus open my schedule').how, 'misheard');
});

test('ordinary sentences about the fruit, a place or a time never wake it', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const wake = wakeMatcher('Citrus');
  for (const said of [
    "let's hit citrus tomorrow",
    'we should hit citrus early',
    'hit citrus tomorrow',
    'hit citrus at nine',
    'citrus is sour on its own',
    'citrus juice is sold at eight',
    'the citrus fruit is ripe',
    'I left my bag near the citrus grove',
    "citrus's new flavor",
    'okay citrus is far from here',
    'Citrus fruit is healthy',
    'Citrus ist heute zu',
  ]) {
    assert.equal(wake.match(said), null, `stays asleep: ${said}`);
  }
});

test('the name is heard the ways a speech engine hears it: Sitrus, Zitrus, Citros', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const wake = wakeMatcher('Citrus');
  for (const [said, rest] of [['hey sitrus what is next', 'what is next'], ['Hallo Zitrus, dunkler Modus', 'dunkler Modus'], ['hello Citros open my schedule', 'open my schedule'], ['hit kitrus dark mode', 'dark mode']]) {
    assert.equal(wake.match(said)?.rest, rest, said);
  }
  // Fruit talk is not a wake, even where the name is the first word.
  for (const said of ['citrus juice with breakfast', 'citrus fruits are rich in vitamin c', 'hit citrus trees at the farm', 'Zitrusfrüchte sind sauer']) {
    assert.equal(wake.match(said), null, `stays asleep: ${said}`);
  }
  // A person who names the assistant something else (even the old name) is understood just the same.
  assert.equal(wakeMatcher('Campus').match('hey kampus, what is next')?.rest, 'what is next');
});

test('a comma after the name means it is being addressed', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const wake = wakeMatcher('Citrus');
  assert.equal(wake.match('Citrus, is it raining?')?.rest, 'is it raining?');
  assert.equal(wake.match('Citrus open my schedule')?.rest, 'open my schedule');
});

test('half-heard phrases wait for a whole word after a misheard greeting', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const wake = wakeMatcher('Citrus');
  // While "hit citrus tomorrow" is still being heard, "hit citrus t" must not wake.
  assert.equal(wake.ready(wake.match('hit citrus t'), false), false);
  assert.equal(wake.ready(wake.match('hit citrus'), false), false);
  assert.equal(wake.ready(wake.match('hit citrus'), true), true, 'a finished "hit citrus" waits for the command');
  assert.equal(wake.ready(wake.match('hit citrus open'), false), false, 'the first word may still be growing');
  assert.equal(wake.ready(wake.match('hit citrus open my'), false), true);
  assert.equal(wake.ready(wake.match('hey citrus'), false), true, 'a clear greeting wakes at once');
});

test('a lecture microphone only takes the bare name with a pause mark', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  const lecture = wakeMatcher('Citrus', { strict: true });
  assert.equal(lecture.match('Citrus explains the next part'), null);
  assert.equal(lecture.match('Citrus, explain the last thing I said')?.rest, 'explain the last thing I said');
  assert.equal(lecture.match('hey citrus explain the last thing I said')?.rest, 'explain the last thing I said');
});

test('stop works with every way of waking, and other names work the same way', async () => {
  const { wakeMatcher } = await load('features/wake-phrase.js');
  assert.ok(wakeMatcher('Citrus').isStop('Citrus, stop'));
  assert.ok(wakeMatcher('Citrus').isStop('hit citrus stop'));
  assert.ok(!wakeMatcher('Citrus').isStop('Citrus, stop the timer and add a note'));
  const max = wakeMatcher('Max');
  assert.equal(max.match('hey Max, what time is it')?.rest, 'what time is it');
  assert.equal(max.match('hit max what time is it')?.rest, 'what time is it');
  assert.equal(max.match('the max is three'), null);
});
