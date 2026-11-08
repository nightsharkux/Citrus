/**
 * Voice: wake word ("Hey Campus" / "Campus"), dictation, read-aloud and live captions.
 *
 * Uses the browser's Web Speech API. Chrome and Edge send audio to their speech
 * service; Safari supports it on recent versions; Firefox does not. Microphone
 * access needs HTTPS (or this computer). An on-device engine can replace
 * `Recognition` here without touching any page.
 */
import { toast } from '../core/ui.js';

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const lang = () => (document.documentElement.lang === 'de' ? 'de-DE' : navigator.language || 'en-US');

/** Null when voice works here, otherwise a short reason to show the user. */
export function voiceProblem() {
  if (!Recognition) return 'Voice needs Chrome, Edge or Safari.';
  if (!window.isSecureContext) return 'Voice needs a secure link. Open Campus OS on this computer, or use the https link from share-online.';
  return null;
}

// ------------------------------------------------------------------ wake word

const stack = [];
const stateListeners = new Set();
let recognizer = null;
let enabled = false;
let paused = false;
let speaking = false;
let armedUntil = 0;
let wakeRe = /^(?:(?:hey|hi|hallo|okay|ok)[\s,!.]+)?camp\s?us\b[\s,.:!?]*(.*)$/i;
let fallback = null;

function setState(state) {
  stateListeners.forEach((fn) => fn(state));
}

function dispatch(text) {
  const handler = stack[stack.length - 1] || fallback;
  handler?.(text);
}

function listen() {
  if (!enabled || paused || recognizer || !Recognition) return;
  const rec = new Recognition();
  recognizer = rec;
  rec.lang = lang();
  rec.continuous = true;
  rec.interimResults = false;
  rec.onresult = (e) => {
    if (speaking) return;
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      if (!e.results[i].isFinal) continue;
      const heard = e.results[i][0].transcript.trim();
      const m = wakeRe.exec(heard);
      if (m && m[1].trim().length > 1) {
        armedUntil = 0;
        setState('heard');
        dispatch(m[1].trim());
      } else if (m) {
        armedUntil = Date.now() + 8000;
        setState('armed');
        dispatch('');
      } else if (Date.now() < armedUntil && heard.length > 1) {
        armedUntil = 0;
        setState('heard');
        dispatch(heard);
      }
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('Microphone access is blocked for this site. Allow it in the browser to use “Hey Campus”.', 'error', { duration: 6000 });
      wake.stop();
      setState('blocked');
    }
  };
  rec.onend = () => {
    if (recognizer === rec) recognizer = null;
    if (enabled && !paused) setTimeout(listen, 350);
  };
  try {
    rec.start();
    setState('listening');
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
  get armed() {
    return Date.now() < armedUntil;
  },
  /** Start listening app-wide. Returns false (with a toast) when voice isn't available here. */
  start(name = 'Campus') {
    const problem = voiceProblem();
    if (problem) {
      toast(problem, 'error', { duration: 6000 });
      return false;
    }
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s?');
    wakeRe = new RegExp(`^(?:(?:hey|hi|hallo|okay|ok)[\\s,!.]+)?${escaped}\\b[\\s,.:!?]*(.*)$`, 'i');
    enabled = true;
    paused = false;
    listen();
    return true;
  },
  stop() {
    enabled = false;
    armedUntil = 0;
    halt();
    setState('off');
  },
  /** Temporarily release the microphone (e.g. for dictation). */
  pause() {
    paused = true;
    halt();
  },
  resume() {
    paused = false;
    listen();
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
  onState(fn) {
    stateListeners.add(fn);
    return () => stateListeners.delete(fn);
  },
};

// ------------------------------------------------------------------ dictation & speech

/** One utterance → text. Pauses the wake word while it runs. */
export function dictate(onText, onEnd = () => {}) {
  const problem = voiceProblem();
  if (problem) {
    toast(problem, 'error', { duration: 6000 });
    return;
  }
  const resumeWake = wake.enabled;
  if (resumeWake) wake.pause();
  const rec = new Recognition();
  rec.lang = lang();
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => onText(e.results[0][0].transcript);
  rec.onerror = (e) => e.error !== 'no-speech' && e.error !== 'aborted' && toast(`Voice input: ${e.error}`, 'error');
  rec.onend = () => {
    onEnd();
    if (resumeWake) wake.resume();
  };
  try {
    rec.start();
  } catch {
    onEnd();
  }
}

/** Read text aloud. The wake word ignores what it hears meanwhile. */
export function speak(text, { onStart, onEnd } = {}) {
  if (!('speechSynthesis' in window)) {
    toast('Read-aloud isn’t available in this browser.', 'error');
    return;
  }
  const clean = String(text).replace(/\[\d+\]/g, '').replace(/[*_`#>]/g, '').slice(0, 3000);
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = lang();
  utterance.onstart = () => {
    speaking = true;
    onStart?.();
  };
  utterance.onend = utterance.onerror = () => {
    speaking = false;
    onEnd?.();
  };
  speechSynthesis.speak(utterance);
}

export const stopSpeaking = () => 'speechSynthesis' in window && speechSynthesis.cancel();

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
