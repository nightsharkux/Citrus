'use strict';
/**
 * Campus's voice (public/js/features/speaker.js), run against simulated browser engines: speech that streams in
 * is said one sentence at a time and in order, a sentence the engine drops is skipped instead of stopping the
 * answer, cancelling stops at once, natural voices play back to back without gaps or overlaps, and a failing
 * natural voice hands over to the device voice without losing words.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ---- browser stand-ins, installed before the modules load
const synth = {
  log: [], // every utterance handed to the engine
  done: [], // utterances that finished
  queue: [],
  maxQueued: 0,
  dropNext: 0, // the next n utterances never start (Chrome does this after a cancel)
  cancels: 0,
  speaking: false,
  pending: false,
  paused: false,
  reset() {
    Object.assign(this, { log: [], done: [], queue: [], maxQueued: 0, dropNext: 0, cancels: 0, speaking: false, pending: false });
  },
  speak(u) {
    this.queue.push(u);
    this.log.push(u);
    this.maxQueued = Math.max(this.maxQueued, this.queue.length);
    if (this.dropNext > 0) {
      this.dropNext -= 1;
      return;
    }
    setTimeout(() => {
      if (u.cancelled) return;
      this.speaking = true;
      u.onstart?.();
      setTimeout(() => {
        if (u.cancelled) return;
        this.queue = this.queue.filter((x) => x !== u);
        this.speaking = false;
        this.done.push(u);
        u.onend?.();
      }, 4 + u.text.length * 0.15);
    }, 2);
  },
  cancel() {
    this.cancels += 1;
    const was = this.queue;
    this.queue = [];
    this.speaking = false;
    for (const u of was) {
      u.cancelled = true;
      u.onerror?.({ error: 'canceled' });
    }
  },
  resume() {},
  getVoices: () => [],
  addEventListener() {},
};

class Utterance {
  constructor(text) {
    this.text = text;
  }
  addEventListener() {}
}

const requests = [];
let failFrom = Infinity; // natural speech fails from this request on
class FakeAudio {
  constructor() {
    FakeAudio.last = this;
    this.state = 'running';
    this.t0 = performance.now();
    this.destination = {};
    this.played = [];
  }
  get currentTime() {
    return (performance.now() - this.t0) / 1000;
  }
  resume() {
    return Promise.resolve();
  }
  createGain() {
    return { gain: { value: 1 }, connect: (n) => n };
  }
  createAnalyser() {
    return { fftSize: 512, connect: (n) => n, getFloatTimeDomainData: (a) => a.fill(0.2) };
  }
  createBufferSource() {
    const ctx = this;
    const src = {
      connect() {},
      start(at) {
        ctx.played.push({ at, duration: src.buffer.duration, text: src.buffer.text });
        src.timer = setTimeout(() => src.onended?.(), Math.max(0, (at - ctx.currentTime) * 1000) + src.buffer.duration * 1000);
      },
      stop() {
        clearTimeout(src.timer);
        src.onended?.();
      },
    };
    return src;
  }
  decodeAudioData(bytes, ok) {
    setTimeout(() => ok({ duration: 0.03, text: Buffer.from(bytes).toString() }), 1);
  }
}

Object.assign(globalThis, {
  window: globalThis,
  document: { documentElement: { lang: 'en', dataset: {} } },
  speechSynthesis: synth,
  SpeechSynthesisUtterance: Utterance,
  AudioContext: FakeAudio,
  addEventListener() {},
  requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 16),
  fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length >= failFrom) return new Response('', { status: 503 });
    return new Response(body.text);
  },
});
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {} }, configurable: true });

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);
const lastAudio = () => FakeAudio.last;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Feed text in small pieces, as a streamed answer arrives, and resolve with how speech ended. */
async function stream(speaker, text, size = 9) {
  for (let i = 0; i < text.length; i += size) {
    speaker.feed(text.slice(i, i + size));
    await wait(1);
  }
  speaker.end();
}
function track() {
  const out = { starts: 0 };
  out.ended = new Promise((resolve) => { out.resolve = resolve; });
  out.started = new Promise((resolve) => { out.begin = resolve; });
  out.options = { onStart: () => { out.starts += 1; out.begin(); }, onEnd: (reason) => out.resolve(reason) };
  return out;
}

const ANSWER = 'The library opens at eight. It closes at ten in the evening, and on Saturdays it opens at nine. Do you want me to add a study session?';

test('the device voice says a streamed answer one sentence at a time, in order, and ends once', async () => {
  const { createSpeaker, isSpeaking } = await load('features/speaker.js');
  const { setSession } = await load('core/store.js');
  setSession({ ai: { speech: false } });
  synth.reset();
  const t = track();
  const speaker = createSpeaker(t.options);
  assert.equal(speaker.engine, 'device');
  await stream(speaker, ANSWER);
  assert.equal(await t.ended, 'done');
  assert.equal(t.starts, 1, 'onStart once');
  assert.equal(synth.maxQueued, 1, 'never more than one sentence queued in the browser (Chrome skips some of a long queue)');
  assert.equal(synth.done.map((u) => u.text).join(' '), ANSWER);
  assert.equal(isSpeaking(), false);
});

test('a sentence the engine drops is skipped; the rest of the answer is still said', async () => {
  const { createSpeaker, timing } = await load('features/speaker.js');
  timing.deviceStart = 50;
  synth.reset();
  synth.dropNext = 1;
  const t = track();
  const speaker = createSpeaker(t.options);
  await stream(speaker, ANSWER, 400);
  assert.equal(await t.ended, 'done');
  const said = synth.done.map((u) => u.text).join(' ');
  assert.ok(!said.includes('opens at eight'), 'the dropped sentence');
  assert.ok(said.includes('It closes at ten') && said.endsWith('study session?'), 'everything after it');
  timing.deviceStart = 9000;
});

test('stopping Campus silences it at once and reports it once', async () => {
  const { createSpeaker, stopSpeaking, isSpeaking } = await load('features/speaker.js');
  synth.reset();
  let ends = 0;
  let reason = null;
  const speaker = createSpeaker({ onEnd: (r) => { ends += 1; reason = r; } });
  speaker.feed(ANSWER);
  await wait(6);
  assert.equal(isSpeaking(), true);
  stopSpeaking();
  const handed = synth.log.length;
  await wait(60);
  assert.equal(reason, 'cancelled');
  assert.equal(ends, 1);
  assert.equal(synth.log.length, handed, 'nothing else is said after stopping');
  assert.equal(isSpeaking(), false);
  speaker.end();
  assert.equal(ends, 1, 'a late end() does not report again');
});

test('one answer keeps one language: a short English word in a German answer does not switch the voice', async () => {
  const { createSpeaker } = await load('features/speaker.js');
  synth.reset();
  const t = track();
  const speaker = createSpeaker(t.options);
  await stream(speaker, 'Die Bibliothek öffnet morgen um acht Uhr. Okay. Sie schließt um zehn Uhr am Abend, und am Samstag ist sie bis zwölf geöffnet.');
  assert.equal(await t.ended, 'done');
  assert.ok(synth.done.length >= 2);
  assert.ok(synth.done.every((u) => u.lang === 'de-DE'), synth.done.map((u) => `${u.lang}: ${u.text}`).join(' | '));
  assert.equal(speaker.language, 'de');
});

test('natural voices: fetched ahead, played back to back without gaps or overlaps, first sentence alone', async () => {
  const { createSpeaker, isSpeaking, speechLevel } = await load('features/speaker.js');
  const { setSession } = await load('core/store.js');
  setSession({ ai: { speech: true } });
  synth.reset();
  requests.length = 0;
  failFrom = Infinity;
  const t = track();
  const speaker = createSpeaker(t.options);
  assert.equal(speaker.engine, 'natural');
  const playing = stream(speaker, ANSWER);
  await t.started;
  assert.equal(isSpeaking(), true);
  await wait(40);
  assert.ok(speechLevel() > 0, 'the face can follow the loudness');
  await playing;
  assert.equal(await t.ended, 'done');
  assert.equal(t.starts, 1);
  assert.equal(isSpeaking(), false);
  assert.equal(synth.log.length, 0, 'the device voice was not used');
  assert.equal(requests.map((r) => r.text).join(' '), ANSWER, 'every word, in order');
  assert.equal(requests[0].text, 'The library opens at eight.', 'speech starts with the first sentence');
  assert.ok(requests.length < 4, 'later sentences are sent a few at a time, which sounds more natural');
  assert.ok(requests.every((r) => r.lang === 'en'));
  // Back to back: each piece starts when the one before ends (a short breath), never on top of it.
  const played = lastAudio().played;
  for (let i = 1; i < played.length; i += 1) {
    const gap = played[i].at - (played[i - 1].at + played[i - 1].duration);
    assert.ok(gap >= -0.001 && gap < 0.2, `gap ${gap.toFixed(3)} s before piece ${i}`);
  }
});

test('natural voices that fail mid-answer hand over to the device voice without losing words', async () => {
  const { createSpeaker } = await load('features/speaker.js');
  const { setSession } = await load('core/store.js');
  setSession({ ai: { speech: true } });
  synth.reset();
  requests.length = 0;
  failFrom = 2; // the second piece fails
  const t = track();
  const speaker = createSpeaker(t.options);
  await stream(speaker, ANSWER, 400);
  assert.equal(await t.ended, 'done');
  const natural = requests[0].text;
  const device = synth.done.map((u) => u.text).join(' ');
  assert.equal(`${natural} ${device}`, ANSWER, 'the device voice picks up exactly where the natural one stopped');
  failFrom = Infinity;
  // Natural voices now rest, so the next answer goes straight to the device voice.
  assert.equal(createSpeaker().engine, 'device');
});
