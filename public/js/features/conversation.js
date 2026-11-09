/**
 * Voice conversation: talk with Campus hands-free, like a phone call.
 *
 * Open it with the waveform button in the assistant, "Talk to Campus" in the
 * command palette, or by saying "Hey Campus, let's talk". Campus listens,
 * notices when you have finished, answers out loud while the answer is still
 * being written, then listens again. The exchange is saved in an ordinary
 * conversation thread (the one open in the assistant, or a new one).
 *
 *   listening → hearing (your words, live) → thinking → speaking → listening …
 *
 * Browser speech is fragile, so:
 *   - the microphone session reopens whenever the browser drops it, with
 *     back-off, and stops with a clear reason (blocked, no microphone, no
 *     speech service) and a Try again button instead of failing silently;
 *   - the end of a turn is a pause, longer after "and", "because", "um" …
 *     (features/turns.js); tapping the eye sends at once;
 *   - on computers the microphone stays open while Campus talks, so you can
 *     interrupt by speaking; what it hears of Campus's own voice is recognised
 *     and ignored. Phones route speech to the earpiece while the microphone is
 *     open, so there the microphone pauses while Campus talks: tap to interrupt;
 *   - speech that stalls is detected (voice.js) and the conversation carries on;
 *   - after two quiet minutes the microphone turns itself off.
 * "Hey Campus" pauses while a conversation is open. Asking Campus to open a
 * page shrinks the conversation to a pill, so you can keep talking there.
 */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { stream } from '../core/api.js';
import { session, setSession, assistantName, on as onStore } from '../core/store.js';
import { navigate } from '../core/router.js';
import { toast } from '../core/ui.js';
import { speakable } from '../core/math.js';
import { setTheme } from '../shell.js';
import { createFace } from './face.js';
import { wake, chime, createListener, createSpeaker, primeSpeech, stopSpeaking, voiceProblem, noteSpoken, recognitionLanguage, speakingLanguage, preferLoudspeaker } from './voice.js';
import { applySettingsEffect, deviceSettings, openLink } from './preferences.js';
import { endOfTurnDelay, isEcho, isInterruption, conversationCommand, words, detectLanguage } from './turns.js';
import { matchCommand } from './commands.js';

const QUIET_LIMIT = 120_000;

const TROUBLE = {
  blocked: 'Microphone access is blocked for this site. Allow it in the browser’s address bar, then try again.',
  'no-microphone': 'No microphone was found. Connect one and try again.',
  network: 'The speech service cannot be reached. Check the connection and try again.',
  unsupported: 'This browser has no speech recognition for your language.',
  unstable: 'The microphone keeps stopping. Make sure no other app is using it, then try again.',
};

let current = null;

/** True while a voice conversation is open (expanded or shrunk to a pill). */
export const conversationOpen = () => !!current;

/** Why a voice conversation cannot start here, or null. */
export function conversationProblem() {
  if (!('speechSynthesis' in window)) return 'Voice conversations need Chrome, Edge or Safari.';
  return voiceProblem();
}

/**
 * Open the conversation (or bring an open one back to full screen).
 * `threadId` continues that thread; without it the first answer starts a new one.
 */
export function startConversation({ threadId = null } = {}) {
  if (current) {
    current.expand();
    return true;
  }
  const problem = conversationProblem();
  if (problem) {
    toast(problem, 'error', { duration: 6000 });
    return false;
  }
  if (session.ai && !session.ai.aiEnabled) {
    toast(`${assistantName()} is asleep until an AI model is connected.`, 'info');
    return false;
  }
  primeSpeech();
  current = createConversation({ threadId });
  return true;
}

export function endConversation() {
  current?.close();
}

/** Plain text of an answer for the captions (formulas as words, no Markdown), ending with its last ~300 characters. */
function captionOf(text, max = 320) {
  const plain = speakable(text).replace(/\s+/g, ' ').replace(/ ([.,!?;:])/g, '$1').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(-max);
  const start = cut.search(/[.!?]\s/);
  return `…${start > 0 && start < 140 ? cut.slice(start + 2) : cut}`;
}

function createConversation({ threadId: startThread }) {
  const touch = matchMedia('(pointer: coarse)').matches;
  const listenWhileSpeaking = !touch;
  const name = assistantName();
  let threadId = startThread || null;
  let state = 'starting';
  let note = '';
  let muted = false;
  let minimized = false;
  let closed = false;
  let recovering = false;

  // What the user is saying.
  let results = null;
  let turnFrom = 0; // first result of the current turn in this microphone session
  let carry = ''; // words of this turn heard in an earlier session
  let heard = '';
  let heardFinal = false;
  let turnTimer = 0;
  let quietTimer = 0;

  // What Campus is saying.
  let turn = 0; // bumps on every question, interruption and close: late callbacks check it
  let controller = null;
  let speaker = null;
  let reply = '';
  let lastReply = '';
  let spokeAt = 0;
  let effects = [];
  let closeAfterSpeech = false;
  let pendingTrouble = null; // the microphone failed while Campus was talking: shown once it is quiet
  let captionFrame = 0;

  const resumeWake = wake.enabled;
  if (resumeWake) wake.pause();
  const returnFocus = document.activeElement;

  // ---- View
  const root = document.createElement('div');
  root.className = 'talk-root';
  render(root, html`
    <div class="talk" role="dialog" aria-modal="true" aria-label="Voice conversation with ${name}" data-state="starting">
      <div class="talk-top">
        <button class="btn btn-ghost btn-icon" data-talk-minimise aria-label="Shrink to a pill" title="Keep talking while you use the app">${icon('chevron-down', 22)}</button>
        <span class="talk-name">${name}</span>
        <span class="talk-top-spacer"></span>
      </div>
      <div class="talk-stage">
        <button class="talk-orb" data-talk-orb aria-label="Tap to send now or interrupt">
          <span class="talk-halo" aria-hidden="true"></span>
          <span data-talk-face></span>
        </button>
        <p class="talk-status" data-talk-status role="status" aria-live="polite">Starting the microphone</p>
      </div>
      <div class="talk-captions">
        <p class="talk-you" data-talk-you></p>
        <div class="talk-actions" data-talk-actions></div>
        <p class="talk-reply" data-talk-reply>Ask anything. Say “goodbye” when you’re done.</p>
        <button class="btn btn-sm talk-retry" data-talk-retry hidden>${icon('refresh', 15)} Try again</button>
      </div>
      <div class="talk-controls">
        <button class="talk-btn" data-talk-mute aria-pressed="false" aria-label="Turn microphone off" title="Microphone">${icon('mic', 24)}</button>
        <button class="talk-btn talk-end" data-talk-end aria-label="End conversation" title="End">${icon('x', 26)}</button>
      </div>
      ${touch ? '' : html`<p class="talk-hint">Space sends or interrupts · Esc ends</p>`}
    </div>
    <div class="voice-pill talk-pill" data-talk-pill hidden>
      <span class="voice-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      <button class="talk-pill-open" data-talk-expand aria-label="Open the voice conversation"><span class="voice-text" data-talk-pill-text>Listening</span></button>
      <button class="voice-close" data-talk-end aria-label="End conversation">${icon('x', 16)}</button>
    </div>`);
  document.body.append(root);
  document.body.classList.add('talk-open');

  const panel = $('.talk', root);
  const orb = $('[data-talk-orb]', root);
  const face = createFace({ size: touch ? 132 : 168, mood: 'listening', followPointer: false });
  $('[data-talk-face]', root).replaceWith(face.el);
  orb.focus({ preventScroll: true });

  const statusText = () => {
    if (note) return note;
    if (recovering && (state === 'listening' || state === 'hearing')) return 'Reconnecting to the speech service';
    return {
      starting: 'Starting the microphone',
      listening: 'Listening',
      hearing: 'Listening',
      thinking: 'Thinking',
      speaking: listenWhileSpeaking ? 'Speak or tap to interrupt' : 'Tap to interrupt',
      muted: 'Microphone off',
      error: 'Voice stopped',
    }[state];
  };

  function paint() {
    panel.dataset.state = state;
    $('[data-talk-status]', root).textContent = statusText();
    const pillText = $('[data-talk-pill-text]', root);
    pillText.textContent = state === 'hearing' && heard ? `“${heard}”` : statusText();
    $('[data-talk-pill]', root).classList.toggle('has-words', state === 'hearing' && !!heard);
    $('[data-talk-pill]', root).classList.toggle('is-final', state !== 'hearing' && state !== 'speaking'); // bars move only while someone talks
    const mute = $('[data-talk-mute]', root);
    mute.setAttribute('aria-pressed', String(muted));
    mute.setAttribute('aria-label', muted ? 'Turn microphone on' : 'Turn microphone off');
    mute.classList.toggle('is-off', muted);
    render(mute, icon(muted ? 'mic-off' : 'mic', 24));
    $('[data-talk-retry]', root).hidden = state !== 'error';
    const mood = { listening: 'listening', hearing: 'listening', thinking: 'thinking', speaking: 'speaking' }[state] || 'idle';
    if (face.mood !== mood) face.setMood(mood);
  }

  function setState(next, message = '') {
    state = next;
    note = message;
    paint();
  }

  const showYou = (text) => {
    $('[data-talk-you]', root).textContent = text ? `“${text}”` : '';
  };
  const showReply = () => {
    if (captionFrame) return;
    captionFrame = requestAnimationFrame(() => {
      captionFrame = 0;
      $('[data-talk-reply]', root).textContent = captionOf(reply);
    });
  };
  const showAction = (a) => {
    const box = $('[data-talk-actions]', root);
    box.insertAdjacentHTML('beforeend', html`<span class="chip ${a.ok ? 'success' : 'danger'}">${icon(a.ok ? 'check' : 'alert', 13)} ${a.ok ? a.title : 'I could not do that'}</span>`.value);
  };
  const announce = (extra = {}) => document.dispatchEvent(new CustomEvent('campus:conversation', { detail: { open: !closed, threadId, minimized, ...extra } }));

  // ---- Microphone
  const listener = createListener({
    onResult(list) {
      results = list;
      onHeard();
    },
    onSession() {
      // Result numbering restarts; keep what was already said in this turn.
      carry = heard;
      turnFrom = 0;
      results = null;
      if (state === 'starting') listen();
    },
    onRecovering(flag) {
      recovering = flag;
      paint();
    },
    onTrouble(kind) {
      clearTimeout(turnTimer);
      if (state === 'speaking' || state === 'thinking') {
        pendingTrouble = kind; // let the answer finish first
        return;
      }
      setState('error', TROUBLE[kind] || TROUBLE.unstable);
      face.react('sad', 1800);
    },
  });

  /** The words of the current turn: what an earlier session heard plus this session's results from turnFrom on. */
  function readTurn() {
    const parts = [carry];
    let final = true;
    if (results) {
      for (let i = turnFrom; i < results.length; i += 1) {
        const piece = results[i][0].transcript.trim();
        const previous = i > turnFrom ? parts[parts.length - 1] : '';
        // Chrome on Android repeats a phrase with each new word ("what is", "what is the time"): keep the longest.
        if (previous && piece.toLowerCase().startsWith(previous.toLowerCase())) parts[parts.length - 1] = piece;
        else parts.push(piece);
      }
      if (results.length > turnFrom) final = results[results.length - 1].isFinal;
    }
    return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), final };
  }

  /** Forget everything heard so far (it was answered or dismissed). */
  function skipHeard() {
    turnFrom = results ? results.length : 0;
    forgetTurn();
  }

  /** Forget the finished phrases only. A phrase still being spoken stays, so words said just as Campus stops are kept. */
  function skipFinals() {
    let i = results ? results.length : 0;
    while (i > turnFrom && !results[i - 1].isFinal) i -= 1;
    turnFrom = Math.max(turnFrom, i);
    forgetTurn();
  }

  function forgetTurn() {
    carry = '';
    heard = '';
    heardFinal = false;
    clearTimeout(turnTimer);
  }

  /** Right after Campus stops, what the microphone still hears may be the end of its own sentence. */
  const echoOfLastReply = (text) => listenWhileSpeaking && Date.now() - spokeAt < 1500 && isEcho(text, lastReply);

  function onHeard() {
    if (closed || muted || state === 'error') return;
    const { text, final } = readTurn();
    if (!text) return;
    if (state === 'speaking') {
      // Listening in one language while Campus speaks the other: its own voice comes back as "new" words.
      const strict = recognitionLanguage() !== 'multi' && (speakingLanguage() || recognitionLanguage().slice(0, 2)) !== recognitionLanguage().slice(0, 2);
      if (listenWhileSpeaking && isInterruption(text, reply, { final, strict })) {
        interrupt();
        hear(text, final);
      } else if (final) skipFinals(); // Campus hearing itself
      return;
    }
    if (echoOfLastReply(text)) {
      if (final) skipFinals();
      return;
    }
    if (state === 'thinking') {
      // Speaking again while Campus thinks: the new words become the question (the first stays in the thread).
      if (words(text).length < 2 && !conversationCommand(text)) return;
      interrupt();
    }
    hear(text, final);
  }

  function hear(text, final) {
    if (text.length > heard.length) face.pulse(0.7); // the eye widens a little as each word comes in
    heard = text;
    heardFinal = final;
    clearTimeout(quietTimer);
    if (state !== 'hearing') setState('hearing');
    else paint();
    showYou(text);
    clearTimeout(turnTimer);
    turnTimer = setTimeout(endTurn, endOfTurnDelay(heard, { final: heardFinal }) ?? 1200);
  }

  /** Back to listening for the next turn. */
  function listen() {
    if (closed) return;
    skipFinals();
    if (pendingTrouble) {
      const kind = pendingTrouble;
      pendingTrouble = null;
      setState('error', TROUBLE[kind] || TROUBLE.unstable);
      return;
    }
    if (muted) {
      listener.stop();
      setState('muted');
      return;
    }
    if (!listenWhileSpeaking) preferLoudspeaker(false);
    // A phone in the background cannot open the microphone; it reopens when the page is visible again.
    if (!(touch && document.hidden)) listener.start();
    setState('listening');
    // The user may already have started the next sentence while Campus finished its own.
    const { text, final } = readTurn();
    if (text && !echoOfLastReply(text)) {
      hear(text, final);
      return;
    }
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (state !== 'listening' || closed) return;
      setMuted(true);
      $('[data-talk-reply]', root).textContent = 'The microphone turned off after two quiet minutes. Tap the microphone to keep talking.';
    }, QUIET_LIMIT);
  }

  /** Stop whatever Campus is saying or preparing. A theme change it was asked for still happens; opening a page does not. */
  function interrupt() {
    turn += 1;
    controller?.abort();
    controller = null;
    if (speaker) {
      speaker = null;
      stopSpeaking();
    }
    lastReply = reply;
    spokeAt = Date.now();
    face.hideVisual();
    applyEffects({ navigation: false });
  }

  function endTurn() {
    clearTimeout(turnTimer);
    const text = heard.trim();
    skipHeard();
    if (!text) {
      listen();
      return;
    }
    const command = conversationCommand(text);
    if (command === 'end') {
      chime.cancel();
      close();
      return;
    }
    if (command === 'interrupt') {
      showYou('');
      listen();
      return;
    }
    let quiet = false; // "be quiet" and "let's talk" need no spoken reply in a conversation
    const local = matchCommand(text, {
      role: session.user.role,
      navigate: (path) => {
        if (path === '/assistant?new=1') {
          threadId = null;
          $('[data-talk-actions]', root).replaceChildren();
        } else minimise();
        navigate(path);
      },
      setTheme: (mode) => setTheme(mode === 'system' ? null : mode),
      stop: () => {
        quiet = true;
      },
      stopListening: () => close(),
      talk: () => {
        quiet = true;
      },
    });
    if (!local) {
      ask(text);
      return;
    }
    local.run();
    if (closed) return;
    if (quiet) {
      showYou('');
      listen();
      return;
    }
    chime.done();
    sayLine(`${local.say}.`);
  }

  function speakerFor(mine) {
    if (!listenWhileSpeaking) {
      listener.stop(); // phones: release the microphone so speech plays on the loudspeaker
      preferLoudspeaker(true);
    }
    return createSpeaker({
      onStart: () => {
        if (mine === turn && !closed) setState('speaking');
      },
      onEnd: (reason) => {
        if (mine === turn && !closed) answered(reason);
      },
    });
  }

  /** A short line that needs no AI ("Opening Schedule."). */
  function sayLine(text) {
    const mine = ++turn;
    reply = text;
    $('[data-talk-reply]', root).textContent = text;
    speaker = speakerFor(mine);
    speaker.feed(text);
    speaker.end();
  }

  async function ask(text) {
    const mine = ++turn;
    chime.done();
    const recogniser = recognitionLanguage();
    // Follow the person from one language to the other: the microphone listens in the language they spoke last.
    if (noteSpoken(text) && listener.running) listener.refresh();
    showYou(text);
    reply = '';
    effects = [];
    $('[data-talk-reply]', root).textContent = '';
    $('[data-talk-actions]', root).replaceChildren();
    face.hideVisual({ immediate: true });
    setState('thinking');
    controller = new AbortController();
    speaker = speakerFor(mine);
    const said = speaker;
    let failure = null;
    try {
      await stream('/assistant/messages', { prompt: text, thread_id: threadId, mode: 'voice', device: deviceSettings(), heard: detectLanguage(text), recogniser }, {
        signal: controller.signal,
        onEvent(type, payload) {
          if (mine !== turn) return;
          if (type === 'thread' && payload.id !== threadId) {
            threadId = payload.id;
            announce();
          } else if (type === 'delta') {
            reply += payload.text;
            said.feed(payload.text);
            showReply();
          } else if (type === 'action') {
            showAction(payload);
            if (payload.ok && payload.client) effects.push(payload.client);
            face.react(payload.ok ? 'happy' : 'confused', 1200);
          } else if (type === 'visual') {
            if (session.user.preferences?.visuals !== false) face.showVisual(payload);
          } else if (type === 'error') {
            throw Object.assign(new Error(payload.message), { status: 500 });
          }
        },
      });
    } catch (error) {
      if (mine !== turn || error.name === 'AbortError') return;
      failure = error;
    }
    if (mine !== turn || closed) return;
    controller = null;
    if (failure) {
      face.react('sad', 2200);
      let sorry = 'Sorry, I couldn’t finish that answer. Please ask again.';
      if (failure.status === 503) {
        sorry = 'I can’t answer right now because no AI model is connected.';
        setSession({ ai: { ...(session.ai || {}), aiEnabled: false } });
        closeAfterSpeech = true;
      } else if (!navigator.onLine) sorry = 'You seem to be offline. I’ll keep listening.';
      else if (failure.status === 429) sorry = 'That was a lot of questions at once. Give me a moment, then ask again.';
      reply += `${reply ? '\n\n' : ''}${sorry}`;
      said.feed(`\n\n${sorry}`);
      showReply();
    }
    said.end();
  }

  /** Campus has finished speaking, was cut off (Esc, another voice) or could not speak. */
  function answered(reason) {
    speaker = null;
    lastReply = reply;
    spokeAt = Date.now();
    applyEffects({ navigation: reason !== 'cancelled' });
    announce({ answered: true });
    if (closeAfterSpeech) {
      close();
      return;
    }
    if (reason === 'blocked') $('[data-talk-reply]', root).textContent = `${captionOf(reply)} (Your browser didn’t let ${name} speak. Tap anywhere on the page once, then ask again.)`;
    listen();
  }

  /** Things the answer asked the browser to do (open a page, change the theme). The server has checked them. */
  function applyEffects({ navigation = true } = {}) {
    const list = effects;
    effects = [];
    for (const effect of list) {
      if (effect.type === 'theme') setTheme(effect.mode === 'system' ? null : effect.mode);
      else if (effect.type === 'open') openLink(effect.url);
      else if (effect.type === 'settings') {
        applySettingsEffect(effect);
        if (listener.running) listener.refresh();
      } else if (effect.type === 'navigate' && navigation) {
        minimise();
        navigate(effect.path);
      }
    }
  }

  // ---- Controls
  function setMuted(flag) {
    muted = flag;
    clearTimeout(quietTimer);
    if (muted) {
      clearTimeout(turnTimer);
      if (state === 'listening' || state === 'hearing' || state === 'starting') {
        listener.stop();
        skipHeard();
        setState('muted');
      } else paint();
    } else if (state === 'muted' || state === 'error') listen();
    else paint();
  }

  /** The eye: send now while you talk, interrupt while Campus thinks or talks, switch the microphone back on. */
  function tap() {
    if (state === 'hearing') endTurn();
    else if (state === 'thinking' || state === 'speaking') {
      interrupt();
      listen();
    } else if (state === 'muted') setMuted(false);
    else if (state === 'error') retry();
    else face.react('happy', 700);
  }

  function retry() {
    pendingTrouble = null;
    muted = false;
    skipHeard(); // a half-heard phrase from the session that failed is not a question
    listen();
  }

  function minimise() {
    if (minimized || closed) return;
    minimized = true;
    panel.hidden = true;
    $('[data-talk-pill]', root).hidden = false;
    document.body.classList.remove('talk-open');
    announce();
  }

  function expand() {
    if (!minimized || closed) return;
    minimized = false;
    panel.hidden = false;
    $('[data-talk-pill]', root).hidden = true;
    document.body.classList.add('talk-open');
    orb.focus({ preventScroll: true });
    announce();
  }

  function close() {
    if (closed) return;
    closed = true;
    turn += 1;
    clearTimeout(turnTimer);
    clearTimeout(quietTimer);
    cancelAnimationFrame(captionFrame);
    controller?.abort();
    listener.stop();
    if (speaker) stopSpeaking();
    speaker = null;
    if (!listenWhileSpeaking) preferLoudspeaker(false);
    offs.forEach((off) => off());
    face.destroy();
    root.remove();
    document.body.classList.remove('talk-open');
    current = null;
    if (resumeWake && wake.enabled) setTimeout(() => wake.resume(), 300);
    if (returnFocus?.isConnected && !minimized) returnFocus.focus?.({ preventScroll: true });
    announce();
  }

  const onKey = (e) => {
    if (minimized || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === ' ' || e.code === 'Space') {
      // A focused button (the eye is one) handles Space itself with a click.
      if (e.target.closest?.('button, a, input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      if (!e.repeat) tap();
    }
  };
  const onVisibility = () => {
    if (!touch) return;
    // Phones stop the microphone in the background; reopen it when the page is back.
    if (document.hidden) listener.stop();
    else if (state === 'listening' || state === 'hearing') listener.start();
  };
  const offs = [
    on(root, 'click', '[data-talk-orb]', () => tap()),
    on(root, 'click', '[data-talk-mute]', () => setMuted(!muted)),
    on(root, 'click', '[data-talk-end]', () => close()),
    on(root, 'click', '[data-talk-minimise]', () => minimise()),
    on(root, 'click', '[data-talk-expand]', () => expand()),
    on(root, 'click', '[data-talk-retry]', () => retry()),
    onStore('session', (patch) => {
      if ('user' in patch && !patch.user) close();
    }),
  ];
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
  offs.push(() => document.removeEventListener('keydown', onKey), () => document.removeEventListener('visibilitychange', onVisibility));

  paint();
  listener.start();
  announce();
  return { expand, close, minimise };
}
