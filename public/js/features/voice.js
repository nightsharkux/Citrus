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
import { detectLanguage } from './turns.js';
import { session } from '../core/store.js';
import { onSpeakingChange, setLanguageHint, stopSpeaking } from './speaker.js';

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// ------------------------------------------------------------------ languages
//
// People here speak German and English, often mixed. A browser's speech recogniser can only listen for one language
// at a time, so "automatic" listens in the language you spoke last (and you can say "auf Deutsch" / "in English" to
// switch), while a fixed choice always listens in that language. Answers are read in the language they are written in.

let heardLanguage = null; // 'en' | 'de': the language of the last thing the person said
const uiLanguage = () => (document.documentElement.lang === 'de' ? 'de' : 'en');
const englishCode = () => (/^en\b/i.test(navigator.language || '') ? navigator.language : 'en-GB');
const speechPreference = () => session.user?.preferences?.speechLanguage || 'auto';

/** The language code to give the speech recogniser right now. */
export function recognitionLanguage() {
  const pref = speechPreference();
  const code = pref === 'auto' ? heardLanguage || uiLanguage() : pref;
  return code === 'de' ? 'de-DE' : englishCode();
}
const lang = recognitionLanguage;

/**
 * Tell the voice layer what the person just said, so automatic mode follows them from one language to the other.
 * Returns true when the recogniser has to be reopened in the other language (the caller reopens its own).
 */
export function noteSpoken(text) {
  if (speechPreference() !== 'auto') return false;
  const found = detectLanguage(text);
  if (!found || found === heardLanguage) return false;
  const before = recognitionLanguage();
  heardLanguage = found;
  const changed = recognitionLanguage() !== before;
  // The always-on session reopens by itself when it ends, in the new language.
  if (changed && mode === 'idle') {
    try {
      recognizer?.abort();
    } catch {
      /* already stopped */
    }
  }
  return changed;
}

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
  const plain = String(name || 'Campus').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .replace(/ph/g, 'f').replace(/[^a-z\s]/g, '').replace(/(.)\1+/g, '$1').trim();
  const vowel = { a: '[aeo]', e: '[eia]', i: '[iey]', o: '[oua]', u: '[uoaw]', y: '[iye]' };
  const letter = { c: '[ckq]', k: '[ckq]', q: '[ckq]', s: '[sz]{1,2}', z: '[sz]{1,2}', v: '[vwf]', w: '[vwf]', f: '[fv]', t: '[td]', d: '[td]', b: '[bp]', p: '[bp]', g: '[gk]', h: 'h?', j: '[jy]', x: '(?:x|[ck]s)' };
  return [...plain].map((c, i, all) => {
    if (c === ' ') return '\\s?';
    if (vowel[c]) return vowel[c] + (all[i + 1] && vowel[all[i + 1]] ? '?' : '');
    return letter[c] || c;
  }).join('');
}

function wakePattern(letters) {
  const greeting = '(?:hey|hay|hi|hello|hallo|halo|okay|ok|yo|servus|moin|ey|hej)';
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
const stopPattern = (letters) => new RegExp(`^\\W*(?:(?:hey|hay|hi|ok|okay|hallo|ey)\\W+)?${letters}\\W+(?:stop|stopp|quiet|cancel|enough|shut up|be quiet|halt|genug|ruhe|sei still)\\W*$`, 'i');

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
  noteSpoken(text);
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

// Speaking (answers, read-aloud, samples) lives in speaker.js. The wake word only needs to know when Campus is
// talking, so it does not take Campus's own voice for a command.
onSpeakingChange((on) => {
  speaking = on;
  if (!on) {
    mutedUntil = Date.now() + 700;
    ignoreBefore = resultCount;
  }
});
setLanguageHint(() => heardLanguage || uiLanguage());

export { speak, createSpeaker, stopSpeaking, isSpeaking, primeSpeech, previewVoice, speechLevel, speakingLanguage } from './speaker.js';

// ------------------------------------------------------------------ conversation microphone

/**
 * The microphone for a spoken conversation (features/conversation.js): one
 * continuous session with live (interim) results. Browsers end sessions on
 * their own (silence, about a minute, a network hiccup), so it reopens at once,
 * backs off when it keeps failing, and gives up only with a reason.
 *
 *   onResult(results)      the session's SpeechRecognitionResultList, after every change
 *   onSession()            a new session opened: result numbering starts again at 0
 *   onRecovering(flag)     true while it reconnects after network errors, false once heard again
 *   onTrouble(kind)        it stopped for good: blocked · no-microphone · network · unsupported · unstable
 *
 * Returns { start(), stop(), get running }. start() is safe to call while running.
 */
export function createListener({ onResult, onSession, onRecovering, onTrouble } = {}) {
  let rec = null;
  let wanted = false;
  let startedAt = 0;
  let quickEnds = 0;
  let networkErrors = 0;
  let retry = 0;

  const fail = (kind) => {
    wanted = false;
    halt();
    onTrouble?.(kind);
  };
  const halt = () => {
    clearTimeout(retry);
    retry = 0;
    const current = rec;
    rec = null;
    try {
      current?.abort();
    } catch {
      /* already stopped */
    }
  };
  const open = () => {
    retry = 0;
    if (!wanted || rec || !Recognition) return;
    const r = new Recognition();
    rec = r;
    r.lang = lang();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onstart = () => {
      if (rec === r) onSession?.();
    };
    r.onresult = (e) => {
      if (rec !== r) return;
      quickEnds = 0;
      if (networkErrors) {
        networkErrors = 0;
        onRecovering?.(false);
      }
      onResult?.(e.results);
    };
    r.onerror = (e) => {
      if (rec !== r) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') fail('blocked');
      else if (e.error === 'audio-capture') fail('no-microphone');
      else if (e.error === 'language-not-supported') fail('unsupported');
      else if (e.error === 'network') {
        networkErrors += 1;
        if (networkErrors >= 6) fail('network');
        else onRecovering?.(true);
      }
      // 'no-speech' and 'aborted' are routine: the session ends and reopens below.
    };
    r.onend = () => {
      if (rec !== r) return;
      rec = null;
      if (!wanted) return;
      quickEnds = Date.now() - startedAt < 1200 ? quickEnds + 1 : 0;
      if (quickEnds >= 10) {
        fail('unstable');
        return;
      }
      const wait = networkErrors ? Math.min(8000, 400 * 2 ** networkErrors) : quickEnds > 2 ? Math.min(4000, 150 * 2 ** quickEnds) : 40;
      retry = setTimeout(open, wait);
    };
    startedAt = Date.now();
    try {
      r.start();
    } catch {
      // Another session (the wake word, dictation) has not released the microphone yet.
      rec = null;
      quickEnds += 1;
      if (quickEnds >= 10) fail('unstable');
      else retry = setTimeout(open, 250);
    }
  };
  return {
    start() {
      if (wanted && (rec || retry)) return;
      wanted = true;
      quickEnds = 0;
      networkErrors = 0;
      open();
    },
    stop() {
      wanted = false;
      halt();
    },
    get running() {
      return wanted;
    },
    /** Reopen the session in the language that is now expected; it comes back by itself. */
    refresh() {
      try {
        rec?.abort();
      } catch {
        /* already stopped */
      }
    },
  };
}

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
