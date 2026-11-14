/**
 * Voice: the "Hey Campus" wake word, dictation, read-aloud and live captions.
 *
 * Uses Wispr Flow or Deepgram when configured, with WebRTC microphone cleanup and
 * multilingual decoding. Otherwise uses the browser's Web Speech API. Microphone
 * access needs HTTPS (or this computer). All engines expose the same result shape.
 *
 * How "Hey Campus" works:
 *   idle      one microphone session stays open and reads every phrase as it is
 *             spoken (interim results, so there is no wait for the speech service
 *             to finish a sentence). Wispr returns complete phrases after a pause.
 *   heard     the wake phrase was recognised: a chime plays, `onState('heard')`
 *             fires and the words that follow are captured live (`onTranscript`).
 *   dispatch  after a short pause the command goes to the local command layer
 *             (open a page, dark mode, stop…) and otherwise to the page that
 *             registered with `onCommand`, usually the assistant.
 * "Hey Campus" on its own is fine: it waits (about nine seconds) for the command.
 */
import { toast } from '../core/ui.js';
import { detectLanguage, endOfTurnDelay } from './turns.js';
import { session } from '../core/store.js';
import { onSpeakingChange, setLanguageHint, stopSpeaking } from './speaker.js';
import { api } from '../core/api.js';
import { DeepgramRecognition } from './recognition.js';
import { WisprRecognition } from './wispr-recognition.js';
import { GatewayRecognition } from './gateway-recognition.js';
import { chooseMicrophone, microphoneRoute } from './microphone.js';
import { wakeMatcher } from './wake-phrase.js';
import { notePitch, setPitchName } from './pitch.js';
import { keepAwake } from './keep-awake.js';

const NativeRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let cloudRestUntil = 0;
const useExternalRecognition = () => session.ai?.recognition?.enabled && Date.now() >= cloudRestUntil && !!navigator.mediaDevices?.getUserMedia && !!window.WebSocket
  && (['wispr', 'gateway'].includes(session.ai.recognition.provider) ? !!window.AudioWorkletNode && !!(window.AudioContext || window.webkitAudioContext) : !!window.MediaRecorder);
const recognitionAvailable = () => useExternalRecognition() || !!NativeRecognition;
/**
 * While a lecture is running, recognition sessions carry its id so the server can add the lecture's vocabulary (titles,
 * topics, terms from the notes). Only the lecture's own lecturer gets it. Pass null when the lecture page closes.
 */
let liveSession = null;
export function setRecognitionLecture(id) {
  liveSession = id || null;
}

function createRecognition() {
  if (!useExternalRecognition()) return new NativeRecognition();
  const Recognition = session.ai.recognition.provider === 'gateway' ? GatewayRecognition : session.ai.recognition.provider === 'wispr' ? WisprRecognition : DeepgramRecognition;
  return new Recognition({
    requestSession: (language, signal) => api.post('/speech/recognition-session', { language, ...(liveSession ? { live_session: liveSession } : {}) }, { signal }),
    onFailure() {
      if (NativeRecognition) {
        cloudRestUntil = Date.now() + 60000;
        toast('The speech service is unavailable. Using browser speech recognition for now.', 'info');
      }
    },
  });
}

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
  if (pref === 'auto' && useExternalRecognition()) return 'multi';
  const code = pref === 'auto' ? heardLanguage || uiLanguage() : pref;
  return code === 'de' ? 'de-DE' : englishCode();
}
const lang = recognitionLanguage;

/**
 * True when listening would record from Bluetooth headphones, which then play everything in muffled call quality.
 * Deepgram and Wispr record from the computer's own microphone instead when there is one (features/microphone.js);
 * the browser's recogniser always uses the default microphone.
 */
export const microphoneMuffles = () => (useExternalRecognition() ? microphoneRoute().bluetooth : microphoneRoute().defaultBluetooth);
chooseMicrophone().catch(() => {});
navigator.mediaDevices?.addEventListener?.('devicechange', () => chooseMicrophone().catch(() => {}));

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
  if (!recognitionAvailable()) return 'Voice needs a supported browser or configured external recognition.';
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
let wakeRe = null; // wakeMatcher(name)

let mode = 'idle'; // idle | capture
let captureFrom = 0; // index of the first result that belongs to the command
let capturePhrase = false; // the first result still starts with the wake phrase
let captureHandlers = null; // set by dictation: text goes there instead of to a page
let captureTimer = 0;
let lastCommand = '';
let lastFinal = false;
let captureResults = null;
let captureSendRequested = false;
let ignoreBefore = 0;
let resultCount = 0;

let startedAt = 0;
let quickEnds = 0;
let networkErrors = 0;
let speaking = false;
let mutedUntil = 0;

const setState = (state, detail) => stateListeners.forEach((fn) => fn(state, detail));
const emitText = (text, final) => textListeners.forEach((fn) => fn({ text, final }));

/** { rest } when the phrase contains the wake word, with whatever was said after it. Rules: wake-phrase.js. */
function matchWake(text) {
  return wakeRe?.match(text) || null;
}

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
  captureResults = null;
  captureSendRequested = false;
}

function finishCapture(reason) {
  const text = lastCommand.trim();
  if (text && captureResults?.requiresFinal && (!lastFinal || captureResults.audioPending) && recognizer?.commit?.()) {
    captureSendRequested = true;
    return;
  }
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
  const text = lastCommand.trim();
  const wait = text ? endOfTurnDelay(text, { final: lastFinal, silenceMs: captureResults?.silenceMs, requiresFinal: captureResults?.requiresFinal, audioPending: captureResults?.audioPending }) : 9000;
  if (wait === null) return;
  if (captureSendRequested && text) { finishCapture(); return; }
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
  captureResults = e.results;
  resultCount = e.results.length;
  const now = Date.now();
  if (speaking || now < mutedUntil) {
    // Campus is talking: it would hear itself. Only an explicit "Campus, stop" gets through.
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      if (wakeRe?.isStop(e.results[i][0].transcript)) {
        stopSpeaking();
        return;
      }
    }
    return;
  }
  networkErrors = 0;
  quickEnds = 0;

  // "You probably didn't understand that, did you?" after someone explains Campus OS: Campus explains itself
  // (pitch.js). Checked on every phrase, before the wake word, so the command never reaches the assistant.
  for (let i = Math.max(e.resultIndex, ignoreBefore); i < e.results.length; i += 1) {
    if (notePitch(e.results[i][0].transcript)) {
      ignoreBefore = e.results.length;
      clearCapture();
      setState('listening', 'pitch');
      return;
    }
  }

  if (mode === 'idle') {
    for (let i = Math.max(e.resultIndex, ignoreBefore); i < e.results.length; i += 1) {
      // A misheard greeting ("hit campus") or the bare name waits for a whole word, so "hit campus tomorrow" stays asleep.
      if (wakeRe?.ready(matchWake(e.results[i][0].transcript), e.results[i].isFinal)) {
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
  if (!enabled || paused || recognizer || !recognitionAvailable()) return;
  const rec = createRecognition();
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
  rec.onactivity = ({ speaking }) => {
    if (recognizer !== rec || mode !== 'capture') return;
    if (speaking) clearTimeout(captureTimer);
    else armTimer();
  };
  rec.onspeechstart = () => rec.onactivity({ speaking: true });
  rec.onspeechend = () => rec.onactivity({ speaking: false });
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
        toast('The speech service is unavailable, so “Hey Campus” is off. Check the connection and try again.', 'error', { duration: 9000 });
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
    wakeRe = wakeMatcher(name);
    setPitchName(name);
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
  const rec = createRecognition();
  let finalText = '';
  rec.lang = lang();
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    const text = [...e.results].map((r) => r[0].transcript).join(' ').trim();
    onInterim(text);
    if (!e.results.length) { finalText = ''; return; }
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

export { speak, createSpeaker, stopSpeaking, isSpeaking, primeSpeech, previewVoice, speechLevel, speakingLanguage, preferLoudspeaker } from './speaker.js';

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
export function createListener({ onResult, onSession, onRecovering, onTrouble, onActivity } = {}) {
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
    if (!wanted || rec || !recognitionAvailable()) return;
    const r = createRecognition();
    rec = r;
    r.lang = lang();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onactivity = (event) => { if (rec === r) onActivity?.(event); };
    r.onspeechstart = () => { if (rec === r) onActivity?.({ speaking: true }); };
    r.onspeechend = () => { if (rec === r) onActivity?.({ speaking: false }); };
    r.onstart = () => {
      if (rec === r) onSession?.();
      chooseMicrophone().catch(() => {}); // the browser names microphones once one is open
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
    /** Ask for the final corrected transcript while keeping continuous capture alive. */
    finalize() { return rec?.commit?.() || false; },
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
/**
 * Listening through a whole lecture or meeting. Keeps the screen awake while it runs; when the phone locks anyway
 * and the browser stops the microphone, it starts again by itself as soon as the page is visible (the lecture record
 * tags the gap). `label` and `target` go to the Android app's recording service (features/keep-awake.js).
 */
export function createCaptioner({ onFinal, onInterim = () => {}, onStop = () => {}, label = 'Campus OS', target = '' }) {
  if (voiceProblem()) return null;
  let rec = null;
  let running = false;
  let hearing = false;
  let awake = null;
  let networkFailures = 0;
  const resumeWake = wake.enabled;
  const onVisible = () => {
    if (document.visibilityState === 'visible' && running && !hearing) start();
  };
  const start = () => {
    if (!running && resumeWake) wake.pause();
    if (!running) {
      awake = keepAwake({ label, target });
      document.addEventListener('visibilitychange', onVisible);
    }
    running = true;
    hearing = true;
    rec = createRecognition();
    rec.lang = lang();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      networkFailures = 0;
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
      } else if (e.error === 'network') {
        networkFailures += 1;
        if (networkFailures >= 3) {
          running = false;
          toast('The speech service cannot be reached. Check the connection and try again.', 'error');
        }
      }
    };
    rec.onend = () => {
      hearing = false;
      // Locked or in the background: the browser will not listen now; carry on when the page is back.
      if (running && document.visibilityState === 'hidden') return;
      if (running) setTimeout(() => running && !hearing && start(), networkFailures ? Math.min(8000, 500 * 2 ** networkFailures) : 250);
      else finish();
    };
    try {
      rec.start();
    } catch {
      hearing = false;
    }
  };
  /** Stopped for good (by the user, or the microphone was blocked): let the screen sleep again. */
  const finish = () => {
    document.removeEventListener('visibilitychange', onVisible);
    awake?.release();
    awake = null;
    if (resumeWake) wake.resume();
    onStop();
  };
  return {
    start,
    stop() {
      const wasHearing = hearing;
      running = false;
      try {
        rec?.stop();
      } catch {
        /* ignore */
      }
      if (!wasHearing) finish(); // already silent (the phone was locked): onend will not come again
    },
    get running() {
      return running;
    },
  };
}
