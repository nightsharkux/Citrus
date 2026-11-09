/**
 * Campus's voice: everything Campus says aloud goes through here (answers while they stream in, read-aloud,
 * the voice conversation, voice samples).
 *
 * Two engines:
 *   natural  voices made on the server by the AI Gateway's speech models (POST /api/speech). The next piece is
 *            fetched while the current one plays, then everything is scheduled back to back on one Web Audio
 *            clock, so there are no gaps between sentences and none of the browser speech bugs. The face
 *            moves with the loudness of the voice (speechLevel()).
 *   device   the browser's own voices (speechSynthesis), used when the server has no speech model, it fails, or
 *            the person chose them in Settings. One sentence at a time, each with its own watchdog: a sentence
 *            the engine drops or stalls on is skipped, never the rest of the answer.
 * If natural speech fails in the middle of an answer, the rest continues in the device voice.
 *
 * Why the old read-aloud glitched: every sentence was queued at once (Chrome skips some of a long queue, and
 * drops the first after a cancel), a two-second watchdog ended speech that was only slow to start, and the
 * voice could change language from one sentence to the next. None of that applies here: one answer has one
 * language unless a whole paragraph is clearly in the other, and nothing ends until the audio really has.
 */
import { speakable } from '../core/math.js';
import { session } from '../core/store.js';
import { speakBoundary, detectLanguage } from './turns.js';
import { getVoiceSettings, chooseVoice, voiceTuning, naturalSpeed } from './voices.js';

const AudioCtx = window.AudioContext || window.webkitAudioContext;
const hasDevice = 'speechSynthesis' in window;

// ------------------------------------------------------------------ shared state

/** Watchdog timings in ms (tests shorten them). */
export const timing = { deviceStart: 9000, deviceGrace: 6000, afterCancel: 80, afterSkip: 60, audioUnlock: 400 };

let current = null; // the speaker that owns the voice right now
let speakingNow = false;
let level = 0;
const speakingListeners = new Set();
let languageHint = () => null;
let naturalRestsUntil = 0;

/** True while Campus's voice is audible. */
export const isSpeaking = () => speakingNow;
/** 0..1, how loud Campus is right now (the face's mouth follows it). */
export const speechLevel = () => level;
/** fn(true|false) when Campus starts or stops talking (the wake word stops listening to itself meanwhile). */
export function onSpeakingChange(fn) {
  speakingListeners.add(fn);
  return () => speakingListeners.delete(fn);
}
/** The language to read in when a text does not say (voice.js: the language the person spoke last). */
export function setLanguageHint(fn) {
  languageHint = fn;
}
function setSpeaking(on) {
  if (on === speakingNow) return;
  speakingNow = on;
  if (!on) level = 0;
  speakingListeners.forEach((fn) => fn(on));
}
const uiLanguage = () => (document.documentElement.lang === 'de' ? 'de' : 'en');
const englishCode = () => (/^en\b/i.test(navigator.language || '') ? navigator.language : 'en-GB');

/** Natural voices: allowed by the institution, wanted by the person, and not resting after a failure. */
export function naturalVoicesReady() {
  return !!AudioCtx && session.ai?.speech === true && getVoiceSettings().engine !== 'device' && Date.now() >= naturalRestsUntil;
}

// ------------------------------------------------------------------ Web Audio

let audio = null;
function audioGraph() {
  if (!AudioCtx) return null;
  if (!audio) {
    try {
      const ctx = new AudioCtx();
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      gain.connect(analyser).connect(ctx.destination);
      audio = { ctx, gain, analyser, samples: new Float32Array(analyser.fftSize) };
    } catch {
      return null;
    }
  }
  if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
  return audio;
}
// Browsers only start audio after a gesture: the first click or key press unlocks it for the visit.
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => audioGraph(), { once: true, passive: true });

/** Loudness of what is playing, smoothed, while natural audio plays. */
let meter = 0;
function runMeter() {
  if (meter) return;
  const tick = () => {
    meter = 0;
    if (!audio || !speakingNow || current?.engine !== 'natural') return;
    audio.analyser.getFloatTimeDomainData(audio.samples);
    let sum = 0;
    for (const v of audio.samples) sum += v * v;
    const rms = Math.sqrt(sum / audio.samples.length);
    const target = Math.min(1, rms * 5.5);
    level += (target - level) * (target > level ? 0.55 : 0.18);
    meter = requestAnimationFrame(tick);
  };
  meter = requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ device voices

// Chrome never fires `end` for an utterance that was garbage-collected, so the one playing is kept here.
let deviceUtterance = null;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Split a piece the device engine would choke on: Chrome's online voices stop after about 15 seconds. */
function deviceChunks(text, max = 170) {
  const out = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
    const at = cut > 60 ? cut + 1 : window.lastIndexOf(' ') > 40 ? window.lastIndexOf(' ') : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function utteranceFor(text, language) {
  const settings = getVoiceSettings();
  const utterance = new SpeechSynthesisUtterance(text);
  const code = language === 'de' ? 'de-DE' : englishCode();
  const voice = chooseVoice(settings, code);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = code;
  }
  const { rate, pitch, volume } = voiceTuning(settings);
  utterance.rate = rate;
  utterance.pitch = pitch;
  utterance.volume = volume;
  return utterance;
}

/**
 * Say one chunk with the device voice. Resolves 'done', 'skipped' (the engine dropped or stalled on it),
 * 'blocked' (no click on the page yet) or 'cancelled'.
 */
function sayOnDevice(text, language, isLive, onStart) {
  return new Promise((resolve) => {
    const utterance = utteranceFor(text, language);
    deviceUtterance = utterance;
    let started = false;
    let settled = false;
    let startTimer = 0;
    let endTimer = 0;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      clearTimeout(endTimer);
      if (deviceUtterance === utterance) deviceUtterance = null;
      resolve(result);
    };
    utterance.onstart = () => {
      started = true;
      clearTimeout(startTimer);
      onStart();
      // Generous: a slow voice reads about 9 characters a second.
      const rate = Number(utterance.rate) || 1;
      // Settle before cancelling: browsers report the cancel at once as an error on this utterance.
      endTimer = setTimeout(() => {
        if (!isLive()) return settle('cancelled');
        settle('skipped');
        speechSynthesis.cancel();
      }, timing.deviceGrace + (text.length / 9 / rate) * 1000);
    };
    utterance.onend = () => settle(isLive() ? 'done' : 'cancelled');
    // Only our own stop counts as cancelled (it ends the speaker first). Any other interruption, or an engine
    // error, skips to the next sentence: the answer goes on instead of ending silently.
    utterance.onerror = (e) => {
      if (!isLive()) return settle('cancelled');
      settle(e.error === 'not-allowed' ? 'blocked' : 'skipped');
    };
    // Online voices can take a few seconds to begin; only a voice that never starts is skipped.
    startTimer = setTimeout(() => {
      if (started || !isLive()) return;
      settle('skipped');
      speechSynthesis.cancel();
    }, timing.deviceStart);
    if (speechSynthesis.paused) speechSynthesis.resume();
    speechSynthesis.speak(utterance);
  });
}

// ------------------------------------------------------------------ speakers

/**
 * Speak an answer while it is still being written. `feed(text)` with each piece that arrives, `end()` when it is
 * complete. `onStart()` when the first sound plays; `onEnd(reason)` once: 'done' after the last word, 'cancelled'
 * on cancel() or stopSpeaking(), 'blocked' when the browser refused to make any sound. Only one speaker talks at
 * a time: a new one silences the last. Returns { feed, end, cancel, active, language, engine }.
 * `options`: { engine: 'natural'|'device', voice } to override the saved choice (voice samples).
 */
export function createSpeaker({ onStart, onEnd, options = {} } = {}) {
  stopSpeaking();
  const settings = getVoiceSettings();
  const wantNatural = options.engine ? options.engine === 'natural' : naturalVoicesReady();
  const sp = {
    engine: wantNatural && AudioCtx && session.ai?.speech ? 'natural' : hasDevice ? 'device' : 'none',
    pieces: [], // { text, lang, buffer?, promise?, failed? }
    buffer: '',
    fed: false,
    over: false,
    begun: false,
    language: null,
    playIndex: 0, // next piece to play
    scheduledUntil: 0, // Web Audio time when everything scheduled so far ends
    sources: new Set(),
    aborter: new AbortController(),
    running: false,
  };
  current = sp;
  const live = () => !sp.over && current === sp;

  const finish = (reason = 'done') => {
    if (sp.over) return;
    sp.over = true;
    sp.aborter.abort();
    for (const src of sp.sources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    sp.sources.clear();
    sp.wake?.(); // release a loop waiting for more text or for the last sound
    if (current === sp) {
      current = null;
      setSpeaking(false);
    }
    onEnd?.(reason);
  };
  const started = () => {
    if (sp.begun || !live()) return;
    sp.begun = true;
    setSpeaking(true);
    onStart?.();
  };

  // ---- natural voice: fetch ahead, schedule back to back
  const voiceId = options.voice ?? settings.natural ?? '';
  const speed = naturalSpeed(settings);
  function fetchPiece(piece) {
    if (piece.promise) return piece.promise;
    const graph = audioGraph();
    piece.promise = fetch('/api/speech', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: piece.text, voice: voiceId || undefined, speed, lang: piece.lang }),
      signal: sp.aborter.signal,
    }).then(async (res) => {
      if (!res.ok) throw Object.assign(new Error('speech'), { status: res.status });
      const bytes = await res.arrayBuffer();
      piece.buffer = await new Promise((resolve, reject) => graph.ctx.decodeAudioData(bytes, resolve, reject));
    }).catch((error) => {
      piece.failed = error?.name === 'AbortError' ? 'aborted' : error?.status || 'network';
    });
    return piece.promise;
  }
  const prefetch = () => {
    for (let i = sp.playIndex; i < Math.min(sp.pieces.length, sp.playIndex + 3); i += 1) fetchPiece(sp.pieces[i]);
  };

  async function runNatural() {
    const graph = audioGraph();
    if (graph && graph.ctx.state !== 'running') await Promise.race([graph.ctx.resume().catch(() => {}), wait(timing.audioUnlock)]);
    // Audio is still locked (no click on the page yet): the device voice may be allowed.
    if (!graph || graph.ctx.state !== 'running') return switchToDevice();
    graph.gain.gain.value = voiceTuning(settings).volume;
    while (live()) {
      prefetch();
      const piece = sp.pieces[sp.playIndex];
      if (!piece) {
        if (sp.fed) break;
        await new Promise((resolve) => { sp.wake = resolve; });
        continue;
      }
      await fetchPiece(piece);
      if (!live()) return;
      if (piece.failed) {
        if (piece.failed === 'aborted') return;
        // 503 / 4xx: natural voices are off or not enabled for this gateway yet. Rest them and carry on.
        naturalRestsUntil = Date.now() + (piece.failed === 429 || piece.failed === 'network' ? 60_000 : 10 * 60_000);
        await wait(Math.max(0, (sp.scheduledUntil - graph.ctx.currentTime) * 1000));
        return switchToDevice();
      }
      const src = graph.ctx.createBufferSource();
      src.buffer = piece.buffer;
      src.connect(graph.gain);
      // A small breath between sentences; the first one starts at once.
      const at = Math.max(graph.ctx.currentTime + 0.03, sp.scheduledUntil + (sp.playIndex ? 0.06 : 0));
      src.start(at);
      sp.sources.add(src);
      src.onended = () => {
        sp.sources.delete(src);
        sp.wake?.();
      };
      sp.scheduledUntil = at + piece.buffer.duration;
      setTimeout(() => {
        started();
        runMeter();
      }, Math.max(0, (at - graph.ctx.currentTime) * 1000));
      sp.playIndex += 1;
      drain(false); // text held back to make longer pieces can go now
    }
    // Everything is scheduled: wait until the last sound has played.
    while (live() && sp.sources.size) await new Promise((resolve) => { sp.wake = resolve; });
    if (live()) finish(sp.begun ? 'done' : 'blocked');
  }

  // ---- device voice: one chunk at a time
  async function runDevice() {
    if (!hasDevice) return finish('blocked');
    // Chrome sometimes swallows an utterance spoken straight after cancel().
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      await wait(timing.afterCancel);
    }
    let blockedCount = 0;
    while (live()) {
      const piece = sp.pieces[sp.playIndex];
      if (!piece) {
        if (sp.fed) break;
        await new Promise((resolve) => { sp.wake = resolve; });
        continue;
      }
      for (const chunk of deviceChunks(piece.text)) {
        if (!live()) return;
        const result = await sayOnDevice(chunk, piece.lang, live, () => {
          started();
          fakeLevel();
        });
        if (result === 'cancelled') {
          if (live()) finish('cancelled'); // never leave a speaker hanging without an end
          return;
        }
        if (result === 'blocked' && ++blockedCount >= 2) return finish('blocked');
        if (result === 'skipped') await wait(timing.afterSkip);
      }
      sp.playIndex += 1;
    }
    if (live()) finish(sp.begun ? 'done' : 'blocked');
  }

  /** The device voice has no level to measure, so the face gets a speech-like rhythm instead. */
  function fakeLevel() {
    if (sp.fakeLevel) return;
    sp.fakeLevel = true;
    const t0 = performance.now();
    const tick = () => {
      if (!live() || sp.engine !== 'device') return;
      const t = (performance.now() - t0) / 1000;
      level = speakingNow ? Math.max(0, 0.45 + 0.35 * Math.sin(t * 11) * Math.sin(t * 2.7 + 1)) : 0;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function switchToDevice() {
    if (!live()) return;
    sp.engine = hasDevice ? 'device' : 'none';
    for (const p of sp.pieces) p.promise = null;
    runDevice();
  }

  function start() {
    if (sp.running || !live()) return;
    sp.running = true;
    if (sp.engine === 'natural') runNatural();
    else if (sp.engine === 'device') runDevice();
    else finish('blocked');
  }

  /** Add one piece of plain text to say. */
  function add(raw) {
    const clean = speakable(raw).replace(/\s+/g, ' ').trim();
    if (!clean || /^[\s.,;:!?…–—-]*$/.test(clean)) return;
    // One answer, one language: set by its first real sentence, switched only by a long passage in the other.
    const found = detectLanguage(clean);
    if (!sp.language) sp.language = found || languageHint() || uiLanguage();
    const lang = found && found !== sp.language && clean.length >= 80 ? found : sp.language;
    sp.pieces.push({ text: clean, lang });
    sp.wake?.();
    start();
  }

  /** Cut finished sentences off the buffer. Natural voices get a few sentences at a time when there is time to wait. */
  function drain(final) {
    for (;;) {
      let cut = speakBoundary(sp.buffer, final);
      if (cut <= 0) break;
      const waiting = sp.pieces.length - sp.playIndex; // pieces not yet playing
      const want = sp.engine === 'natural' && waiting >= 1 ? 220 : 0;
      while (cut < want && cut < sp.buffer.length) {
        const more = speakBoundary(sp.buffer.slice(cut), final);
        if (more <= 0) break;
        cut += more;
      }
      if (cut < want && !final) break; // keep collecting while the voice is busy
      add(sp.buffer.slice(0, cut));
      sp.buffer = sp.buffer.slice(cut);
      if (!sp.buffer.trim()) {
        sp.buffer = '';
        break;
      }
    }
  }

  const api = {
    feed(text) {
      if (!live()) return;
      sp.buffer += text;
      drain(false);
    },
    end() {
      if (!live() || sp.fed) return;
      drain(true);
      sp.fed = true;
      sp.wake?.();
      if (!sp.pieces.length) finish('done');
      else start();
    },
    cancel() {
      if (sp.over) return;
      if (current === sp && sp.engine === 'device' && hasDevice) speechSynthesis.cancel();
      finish('cancelled');
    },
    get active() {
      return !sp.over;
    },
    get language() {
      return sp.language;
    },
    get engine() {
      return sp.engine;
    },
  };
  sp.api = api;
  return api;
}

/** Read a whole text aloud (the speaker button on an answer). Formulas become words; Markdown and citations are dropped. */
export function speak(text, { onStart, onEnd, options } = {}) {
  const sp = createSpeaker({ onStart, onEnd, options });
  sp.feed(String(text || '').slice(0, 6000));
  sp.end();
  return sp;
}

/** Silence Campus now. */
export function stopSpeaking() {
  const sp = current;
  current = null;
  if (hasDevice && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  if (sp && !sp.over) {
    current = sp; // so finish() reports it as the active speaker
    sp.api.cancel();
  }
  setSpeaking(false);
}

/** The language of what Campus is saying now ('en' | 'de'), or null. */
export const speakingLanguage = () => current?.language || null;

/**
 * Call from a click or tap that will lead to speech a few seconds later. Unlocks Web Audio, and Safari's
 * speech, which only works after the page has spoken once inside a user gesture.
 */
export function primeSpeech() {
  audioGraph();
  if (!hasDevice || speakingNow) return;
  try {
    const silent = new SpeechSynthesisUtterance(' ');
    silent.volume = 0;
    speechSynthesis.speak(silent);
  } catch {
    /* nothing to unlock */
  }
}

/** Say a short sample (the voice picker). `options`: { engine, voice }. */
export function previewVoice(text, options = {}) {
  primeSpeech();
  return speak(text, { options });
}
