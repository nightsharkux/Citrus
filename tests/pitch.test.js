'use strict';
/** "What is Campus OS?" for presentations: the lines that start it, and ordinary talk that never does. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);

test('the presentation lines start it', async () => {
  const { matchPitch } = await load('features/pitch.js');
  for (const said of [
    'Now you probably didn’t understand that now, did you?',
    'now you probably didnt understand that now did you',
    'You probably didn’t get any of that.',
    'You didn’t understand that, did you?',
    'In case that wasn’t clear, hey Campus, could you please elaborate further?',
    'in case that wasnt clear hey campus could you please elaborate further',
    'Just in case that wasn’t clear, could you explain it, Campus?',
    'Hey Campus, explain what Campus OS is.',
    'Hey Campus, could you tell everyone what you do?',
    'Hey Campus, introduce yourself.',
    'hit campus explain what campus os is',
    'Du hast das wahrscheinlich nicht verstanden.',
  ]) {
    assert.ok(matchPitch(said), `starts: ${said}`);
  }
});

test('the two halves can come as separate phrases', async () => {
  const { matchPitch } = await load('features/pitch.js');
  assert.ok(matchPitch('hey campus could you please elaborate further', { recent: 'in case that wasn’t clear', answeredRecently: true }));
  assert.ok(matchPitch('did you', { recent: 'you probably didn’t understand that now' }));
});

test('ordinary talk never starts it', async () => {
  const { matchPitch } = await load('features/pitch.js');
  for (const said of [
    'I didn’t understand that, did you?',
    'I probably didn’t understand that.',
    'In case that wasn’t clear, let me explain it again.',
    'In case that wasn’t clear, the exam is on Friday.',
    'Could you please elaborate on the second point?',
    'Hey Campus, explain photosynthesis.',
    'Hey Campus, explain the last thing I said.',
    'Hey Campus, tell me about campus life.',
    'Campus OS is a student project.',
    'the campus is closed, did you understand that',
    'You understood that, right?',
  ]) {
    assert.equal(matchPitch(said), false, `stays quiet: ${said}`);
  }
});

test('"elaborate" right after an answer means that answer, unless the line says it was unclear', async () => {
  const { matchPitch } = await load('features/pitch.js');
  assert.ok(matchPitch('Hey Campus, could you please elaborate further?'), 'nothing was answered just now');
  assert.equal(matchPitch('Hey Campus, could you please elaborate further?', { answeredRecently: true }), false);
  assert.ok(matchPitch('In case that wasn’t clear, hey Campus, could you please elaborate further?', { answeredRecently: true }));
});

test('a lecture or meeting microphone needs the wake word as well', async () => {
  const { matchPitch } = await load('features/pitch.js');
  assert.equal(matchPitch('You probably didn’t understand that, did you?', { requireWake: true }), false, 'a lecturer may say this to the class');
  assert.ok(matchPitch('You probably didn’t understand that, hey Campus, could you elaborate?', { requireWake: true }));
});

test('it fires once, then rests, and the explanation covers the core features', async () => {
  const { notePitch, PITCH, PITCH_CARDS } = await load('features/pitch.js');
  const now = Date.parse('2026-11-13T10:00:00Z');
  assert.equal(notePitch('you probably didnt understand that did you', { now }), true);
  assert.equal(notePitch('you probably didnt understand that did you', { now: now + 5000 }), false, 'no second start right away');
  for (const lang of ['en', 'de']) {
    const cards = PITCH[lang].map((p) => p.card);
    assert.deepEqual([...new Set(cards.filter(Boolean))], ['live', 'review', 'nfc', 'ask'], 'live lecture first, information access last');
    assert.equal(PITCH[lang][0].mood, 'excited');
    assert.equal(PITCH_CARDS[lang].length, 3);
  }
  assert.match(PITCH.en.map((p) => p.text).join(' '), /Campus Puck[\s\S]*NFC/);
});
