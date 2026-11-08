/**
 * Voice: the "Hey Campus" wake word, dictation, read-aloud and live captions.
 *
 * Uses the browser's Web Speech API. Chrome and Edge send audio to their speech
 * service; Safari supports it on recent versions; Firefox does not. Microphone
 * access needs HTTPS (or this computer). An on-device engine can replace
 * `Recognition` here without touching any page.
 *
 * How "Hey Campus" works:
 *   idle      one microphone session stays open and reads every phrase as it is
 *             spoken (interim results, so there is no wait for the speech service
 *             to finish a sentence).
 *   heard     the wake phrase was recognised: a chime plays, `onState('heard')`
 *             fires and the words that follow are captured live (`onTranscript`).
 *   dispatch  after a short pause the command goes to the local command layer
 *             (open a page, dark mode, stop…) and otherwise to the page that
 *             registered with `onCommand`, usually the assistant.
 * "Hey Campus" on its own is fine: it waits (about nine seconds) for the command.
 */
import { toast } from '../core/ui.js';
import { speakable } from '../core/math.js';

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const lang = () => (document.documentElement.lang === 'de' ? 'de-DE' : navigator.language || 'en-US');

/** Null when voice works here, otherwise a short reason to show the user. */
export function voiceProblem() {
  if (!Recognition) return 'Voice needs Chrome, Edge or Safari.';
  if (!window.isSecureContext) return 'Voice needs a secure link. Open Campus OS on this computer, or use the https link from share-online.';
  return null;
}

// ------------------------------------------------------------------ sounds

let audio = null;
function audioContext() {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
  } catch {
    audio = null;
  }
  return audio;
}
// Browsers only start audio after a gesture; the first click or key press unlocks it for the rest of the visit.
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => audioContext(), { once: true, passive: true });

/** Short, soft notes. Silent when the browser has not allowed audio yet (the on-screen cue still shows). */
function notes(list, gain = 0.05) {
  const ctx = audioContext();
  if (!ctx || ctx.state !== 'running') return;
  let at = ctx.currentTime + 0.01;
  for (const [freq, length] of list) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(gain, at + 0.015);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(amp).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + length + 0.02);
    at += length * 0.8;
  }
}
export const chime = {
  heard: () => notes([[660, 0.11], [880, 0.14]]),
  done: () => notes([[880, 0.08], [1175, 0.12]], 0.04),
  cancel: () => notes([[440, 0.12], [330, 0.16]], 0.04),
};

// ------------------------------------------------------------------ wake word

const stack = [];
const stateListeners = new Set();
const textListeners = new Set();
let fallback = null;
let interceptor = null;

let recognizer = null;
let enabled = false;
let paused = false;
let wakeRe = null;
let stopRe = null;

let mode = 'idle'; // idle | capture
let captureFrom = 0; // index of the first result that belongs to the command
let capturePhrase = false; // the first result still starts with the wake phrase
let captureHandlers = null; // set by dictation: text goes there instead of to a page
let captureTimer = 0;
let lastCommand = '';
let lastFinal = false;
let ignoreBefore = 0;
let resultCount = 0;

let startedAt = 0;
let quickEnds = 0;
let networkErrors = 0;
let speaking = false;
let mutedUntil = 0;

const setState = (state, detail) => stateListeners.forEach((fn) => fn(state, detail));
const emitText = (text, final) => textListeners.forEach((fn) => fn({ text, final }));

/**
 * The wake phrase for an assistant name. Speech engines often mishear names, so
 * the pattern accepts the usual confusions (c/k, u/o/a, doubled s: "Campos", "Kampus", "Compass").
 */
function phonetic(name) {
  return [...String(name || 'Campus').toLowerCase().replace(/[^a-z\s]/g, '')].map((c) => {
    if (c === ' ') return '\\s?';
    if (c === 'c' || c === 'k') return '[ck]';
    if (c === 'u' || c === 'o') return '[uoa]';
    if (c === 'a') return '[ao]';
    if (c === 's') return 's{1,2}';
    return c;
  }).join('');
}

function wakePattern(letters) {
  const greeting = '(?:hey|hay|hi|hello|hallo|okay|ok|yo)';
  // "Hey Campus" can come anywhere; a bare "Campus" only at the start, so "the campus library" never wakes it.
  return new RegExp(`(?:^|[\\s,.!?])${greeting}[\\s,.!?]+(${letters})(?=$|[\\s,.!?])[\\s,.:!?]*(.*)$|^\\W*(${letters})(?=$|[\\s,.!?])[\\s,.:!?]*(.*)$`, 'i');
}

/** { rest } when the phrase contains the wake word, with whatever was said after it. */
function matchWake(text) {
  const m = wakeRe?.exec(String(text).trim());
  if (!m) return null;
  return { rest: String(m[2] ?? m[4] ?? '').trim() };
}

/** "Campus, stop" while Campus is talking. */
const stopPattern = (letters) => new RegExp(`^\\W*(?:(?:hey|hay|hi|ok|okay)\\W+)?${letters}\\W+(?:stop|quiet|cancel|enough|shut up|be quiet)\\W*$`, 'i');

function dispatch(text) {
  setState('sent', text);
  if (interceptor?.(text)) return;
  (stack[stack.length - 1] || fallback)?.(text);
}

function clearCapture() {
  clearTimeout(captureTimer);
  captureTimer = 0;
  mode = 'idle';
  captureHandlers = null;
  capturePhrase = false;
  lastCommand = '';
  lastFinal = false;
}

function finishCapture(reason) {
  const text = lastCommand.trim();
  const handlers = captureHandlers;
  ignoreBefore = resultCount;
  clearCapture();
  if (!text) {
    chime.cancel();
    emitText('', true);
    setState('listening', reason || 'nothing heard');
    handlers?.onEnd?.('');
    return;
  }
  if (handlers) {
    handlers.onFinal?.(text);
    handlers.onEnd?.(text);
    setState('listening');
  } else {
    chime.done();
    dispatch(text);
  }
  emitText(text, true);
}

/** (Re)start the quiet-time countdown: a long wait for the first words, a short one after the last. */
function armTimer() {
  clearTimeout(captureTimer);
  const wait = lastCommand.trim() ? (lastFinal ? 900 : 1500) : 9000;
  captureTimer = setTimeout(() => finishCapture(lastCommand.trim() ? '' : 'timeout'), wait);
}

function beginCapture(from, withPhrase, handlers = null) {
  mode = 'capture';
  captureFrom = from;
  capturePhrase = withPhrase;
  captureHandlers = handlers;
  lastCommand = '';
  lastFinal = false;
  if (!handlers) chime.heard();
  setState(withPhrase ? 'heard' : 'armed');
  armTimer();
}

function readCommand(results) {
  const parts = [];
  for (let i = captureFrom; i < results.length; i += 1) {
    let text = results[i][0].transcript;
    if (i === captureFrom && capturePhrase) text = matchWake(text)?.rest ?? text;
    parts.push(text.trim());
  }
  lastFinal = results.length > captureFrom && results[results.length - 1].isFinal;
  return parts.filter(Boolean).join(' ').trim();
}

function onResult(e) {
  resultCount = e.results.length;
  const now = Date.now();
  if (speaking || now < mutedUntil) {
    // Campus is talking: it would hear itself. Only an explicit "Campus, stop" gets through.
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      if (stopRe?.test(e.results[i][0].transcript.trim())) {
        stopSpeaking();
        return;
      }
    }
    return;
  }
  networkErrors = 0;
  quickEnds = 0;

  if (mode === 'idle') {
    for (let i = Math.max(e.resultIndex, ignoreBefore); i < e.results.length; i += 1) {
      if (matchWake(e.results[i][0].transcript)) {
        beginCapture(i, true);
        break;
      }
    }
  }
  if (mode === 'capture') {
    const text = readCommand(e.results);
    if (text !== lastCommand) {
      lastCommand = text;
      emitText(text, false);
      captureHandlers?.onInterim?.(text);
    }
    armTimer();
  }
}

function listen() {
  if (!enabled || paused || recognizer || !Recognition) return;
  const rec = new Recognition();
  recognizer = rec;
  rec.lang = lang();
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.onstart = () => {
    startedAt = Date.now();
    resultCount = 0;
    ignoreBefore = 0;
    if (mode === 'capture') {
      captureFrom = 0; // a new session numbers its results from zero
      capturePhrase = false;
    } else setState('listening');
  };
  rec.onresult = onResult;
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('Microphone access is blocked for this site. Allow it in the browser to use “Hey Campus”.', 'error', { duration: 7000 });
      wake.stop('blocked');
    } else if (e.error === 'audio-capture') {
      toast('No microphone was found. Plug one in and turn on “Hey Campus” again.', 'error', { duration: 7000 });
      wake.stop('blocked');
    } else if (e.error === 'network') {
      networkErrors += 1;
      if (networkErrors >= 3) {
        toast('This browser cannot reach its speech service, so “Hey Campus” is off. Chrome, Edge or Safari with an internet connection work; some privacy-focused browsers block it.', 'error', { duration: 9000 });
        wake.stop('unavailable');
      }
    } else if (e.error === 'language-not-supported') {
      toast('This browser has no speech recognition for your language.', 'error', { duration: 6000 });
      wake.stop('unavailable');
    }
  };
  rec.onend = () => {
    if (recognizer === rec) recognizer = null;
    if (!enabled || paused) return;
    // Sessions end now and then (silence, time limit). Reopen straight away, but back off if they keep failing at once.
    quickEnds = Date.now() - startedAt < 1500 ? quickEnds + 1 : 0;
    if (quickEnds >= 12) {
      toast('“Hey Campus” keeps stopping. Check your microphone and turn it on again.', 'error', { duration: 7000 });
      wake.stop('unavailable');
      return;
    }
    setTimeout(listen, quickEnds > 2 ? Math.min(5000, 250 * 2 ** quickEnds) : 60);
  };
  try {
    rec.start();
  } catch {
    recognizer = null;
  }
}

function halt() {
  const rec = recognizer;
  recognizer = null;
  try {
    rec?.abort();
  } catch {
    /* already stopped */
  }
}

export const wake = {
  get enabled() {
    return enabled;
  },
  /** True while Campus is waiting for, or hearing, a command. */
  get armed() {
    return mode === 'capture';
  },
  /** Start listening app-wide. Returns false (with a toast) when voice isn't available here. */
  start(name = 'Campus') {
    const problem = voiceProblem();
    if (problem) {
      toast(problem, 'error', { duration: 6000 });
      return false;
    }
    const letters = phonetic(name);
    wakeRe = wakePattern(letters);
    stopRe = stopPattern(letters);
    enabled = true;
    paused = false;
    networkErrors = 0;
    quickEnds = 0;
    audioContext();
    listen();
    return true;
  },
  stop(state = 'off') {
    enabled = false;
    clearCapture();
    halt();
    setState(state);
  },
  /** Temporarily release the microphone (e.g. for live captions). */
  pause() {
    paused = true;
    clearCapture();
    halt();
  },
  resume() {
    paused = false;
    listen();
  },
  /**
   * Listen for one command right now, without the wake phrase (a tap on a mic button).
   * Returns false when the always-on session is not running; the caller then opens its own.
   */
  capture(handlers) {
    if (!enabled || paused || !recognizer || mode === 'capture') return false;
    beginCapture(resultCount, false, handlers || null);
    return true;
  },
  /** Stop listening for a command now. What was heard so far is still delivered. */
  finishCapture() {
    if (mode === 'capture') finishCapture();
  },
  /** Drop the command being spoken without sending it. */
  cancelCapture() {
    if (mode !== 'capture') return;
    lastCommand = '';
    finishCapture('cancelled');
  },
  /** Pages register a handler while mounted; the most recent one wins. Returns an unregister function. */
  onCommand(fn) {
    stack.push(fn);
    return () => {
      const i = stack.lastIndexOf(fn);
      if (i >= 0) stack.splice(i, 1);
    };
  },
  /** Used when no page handler is registered (e.g. open the assistant). */
  setFallback(fn) {
    fallback = fn;
  },
  /** First look at every command; return true when it was handled locally ("open schedule"). */
  setInterceptor(fn) {
    interceptor = fn;
  },
  /** state: off · listening · heard · armed · sent · blocked · unavailable */
  onState(fn) {
    stateListeners.add(fn);
    return () => stateListeners.delete(fn);
  },
  /** Live words of the command being spoken: fn({ text, final }). */
  onTranscript(fn) {
    textListeners.add(fn);
    return () => textListeners.delete(fn);
  },
};

// ------------------------------------------------------------------ dictation & speech

/**
 * Speak into a text box. `onInterim(text)` fires while talking (so the words appear
 * as you say them), `onFinal(text)` once you pause, `onEnd()` when listening stops.
 * Uses the already-open "Hey Campus" session when there is one, so it starts at once.
 * Returns { stop() }.
 */
export function dictate({ onInterim = () => {}, onFinal = () => {}, onEnd = () => {} } = {}) {
  const problem = voiceProblem();
  if (problem) {
    toast(problem, 'error', { duration: 6000 });
    onEnd();
    return { stop() {} };
  }
  if (wake.capture({ onInterim, onFinal, onEnd })) return { stop: () => wake.finishCapture() };

  const resumeWake = wake.enabled;
  if (resumeWake) wake.pause();
  const rec = new Recognition();
  let finalText = '';
  rec.lang = lang();
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    const text = [...e.results].map((r) => r[0].transcript).join(' ').trim();
    onInterim(text);
    if (e.results[e.results.length - 1].isFinal) finalText = text;
  };
  rec.onerror = (e) => e.error !== 'no-speech' && e.error !== 'aborted' && toast(e.error === 'not-allowed' ? 'Microphone access is blocked for this site.' : `Voice input: ${e.error}`, 'error');
  rec.onend = () => {
    if (finalText) onFinal(finalText);
    onEnd(finalText);
    if (resumeWake) wake.resume();
  };
  try {
    rec.start();
  } catch {
    onEnd('');
    if (resumeWake) wake.resume();
  }
  return { stop: () => { try { rec.stop(); } catch { /* ended */ } } };
}

let speakToken = 0;
let currentEnd = null;
let voiceChoice = null;

/** A pleasant installed voice for the language: natural/online ones first. */
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  if (voiceChoice && voices.includes(voiceChoice)) return voiceChoice;
  const code = lang().slice(0, 2).toLowerCase();
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(code));
  const rank = (v) => (/natural|online/i.test(v.name) ? 3 : /google|samantha|ava|aria|jenny/i.test(v.name) ? 2 : v.localService ? 0 : 1);
  voiceChoice = [...matching].sort((a, b) => rank(b) - rank(a))[0] || null;
  return voiceChoice;
}

/** Sentences grouped into pieces the browser will read without stalling (long utterances stop after ~15 s in Chrome). */
function pieces(text) {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) || [text];
  const out = [];
  let current = '';
  for (const s of sentences) {
    if (current && (current + s).length > 220) {
      out.push(current.trim());
      current = '';
    }
    current += s;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Read an answer aloud: formulas become words, Markdown and citation numbers are dropped. The wake word ignores what it hears meanwhile. */
export function speak(text, { onStart, onEnd } = {}) {
  if (!('speechSynthesis' in window)) {
    toast('Read-aloud isn’t available in this browser.', 'error');
    return;
  }
  const clean = speakable(text).slice(0, 4000);
  speechSynthesis.cancel();
  const token = ++speakToken;
  const parts = pieces(clean);
  if (!parts.length) {
    onEnd?.();
    return;
  }
  currentEnd = onEnd || null;
  const finish = () => {
    if (token !== speakToken) return;
    speaking = false;
    mutedUntil = Date.now() + 700;
    ignoreBefore = resultCount;
    const done = currentEnd;
    currentEnd = null;
    done?.();
  };
  parts.forEach((part, index) => {
    const utterance = new SpeechSynthesisUtterance(part);
    utterance.lang = lang();
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = 1.04;
    if (index === 0) {
      utterance.onstart = () => {
        if (token !== speakToken) return;
        speaking = true;
        onStart?.();
      };
    }
    utterance.onend = index === parts.length - 1 ? finish : null;
    utterance.onerror = finish;
    speechSynthesis.speak(utterance);
  });
}

export function stopSpeaking() {
  if (!('speechSynthesis' in window)) return;
  const wasSpeaking = speaking;
  speakToken += 1;
  speechSynthesis.cancel();
  if (wasSpeaking) {
    speaking = false;
    mutedUntil = Date.now() + 500;
    ignoreBefore = resultCount;
  }
  const done = currentEnd;
  currentEnd = null;
  done?.();
}

export const isSpeaking = () => speaking;

// ------------------------------------------------------------------ live captions

/** Continuous transcription. onFinal(text) per finished phrase; onInterim(text) while speaking. */
export function createCaptioner({ onFinal, onInterim = () => {}, onStop = () => {} }) {
  if (voiceProblem()) return null;
  let rec = null;
  let running = false;
  const resumeWake = wake.enabled;
  const start = () => {
    if (!running && resumeWake) wake.pause();
    running = true;
    rec = new Recognition();
    rec.lang = lang();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        if (e.results[i].isFinal) onFinal(e.results[i][0].transcript.trim());
        else interim += e.results[i][0].transcript;
      }
      onInterim(interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed') {
        running = false;
        toast('Microphone access was blocked.', 'error');
      }
    };
    rec.onend = () => {
      if (running) setTimeout(() => running && start(), 250);
      else {
        if (resumeWake) wake.resume();
        onStop();
      }
    };
    rec.start();
  };
  return {
    start,
    stop() {
      running = false;
      try {
        rec?.stop();
      } catch {
        /* ignore */
      }
    },
    get running() {
      return running;
    },
  };
}
