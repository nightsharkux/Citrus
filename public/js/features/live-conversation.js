/**
 * The voice conversation with live voice (GPT-Live, features/live.js) on computers.
 *
 * Campus hears you while it talks and works out itself when you have finished, so it answers as soon as you
 * stop and lets you finish when you only pause to think. Talk over it to interrupt; the eye or Space also cuts
 * it off. Questions about your timetable, courses or the university, and anything to do in the app, are handed
 * to the normal assistant (POST /api/assistant/messages, with your permissions) and Campus says the result. Those
 * exchanges are saved in the conversation thread like typed ones.
 *
 * If live voice cannot start (no access on this account, no connection), the standard voice conversation opens
 * instead (features/conversation.js) and live voice rests for ten minutes.
 */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session, setSession, assistantName, on as onStore } from '../core/store.js';
import { navigate } from '../core/router.js';
import { toast } from '../core/ui.js';
import { setTheme } from '../shell.js';
import { createFace } from './face.js';
import { wake } from './voice.js';
import { applySettingsEffect, deviceSettings, openLink } from './preferences.js';
import { conversationCommand, detectLanguage } from './turns.js';
import { getVoiceSettings, saveVoiceSettings } from './voices.js';
import { createLivePlayer, setSpeechVolume, isSpeaking } from './speaker.js';
import { LiveSession, spokenAnswer } from './live.js';

const QUIET_LIMIT = 120_000;
let restsUntil = 0;

/** Live voice can run here: the institution has it, this is a computer, and it is not resting after a failure. */
export function liveVoiceReady() {
  return session.ai?.live === true && !matchMedia('(pointer: coarse)').matches && !!globalThis.AudioWorkletNode
    && !!globalThis.WebSocket && Date.now() >= restsUntil;
}

const tail = (text, max = 320) => {
  const plain = String(text || '').replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(-max);
  const start = cut.search(/[.!?]\s/);
  return `…${start > 0 && start < 140 ? cut.slice(start + 2) : cut}`;
};

const TROUBLE = {
  blocked: 'Microphone access is blocked for this site. Allow it in the browser’s address bar, then try again.',
  'no-microphone': 'No microphone was found. Connect one and try again.',
  lost: 'The live connection dropped. Try again to keep talking.',
  expired: 'The conversation reached its time limit. Try again to start a new one.',
};

/**
 * Open a live conversation. `onClose()` when it has ended; `onFallback(threadId)` when live voice could not start
 * and the standard conversation should open instead. Returns { expand, close, minimise }.
 */
export function startLiveConversation({ threadId: startThread = null, onClose, onFallback }) {
  const name = assistantName();
  let threadId = startThread;
  let state = 'starting';
  let note = '';
  let muted = false;
  let minimized = false;
  let closed = false;
  let live = null;
  let player = null;
  let you = '';
  let reply = '';
  let replyAfterYou = false;
  let pending = 0; // delegations being answered
  let dropping = false; // the eye cut Campus off: ignore the rest of that reply's audio
  let lastAudioAt = 0;
  let lastWordsAt = Date.now();
  let quietTimer = 0;
  let byeTimer = 0;

  const resumeWake = wake.enabled;
  if (resumeWake) wake.pause();
  const returnFocus = document.activeElement;

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
        <button class="talk-orb" data-talk-orb aria-label="Tap to interrupt">
          <span class="talk-halo" aria-hidden="true"></span>
          <span data-talk-face></span>
        </button>
        <p class="talk-status" data-talk-status role="status" aria-live="polite">Connecting</p>
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
      <label class="talk-volume"><span>Volume</span><input type="range" min="0" max="1" step="0.05" value="${getVoiceSettings().volume}" data-talk-volume aria-label="Voice volume"><output data-talk-volume-label>${Math.round(getVoiceSettings().volume * 100)}%</output></label>
      <p class="talk-hint">Talk over Campus or press Space to interrupt · Esc ends</p>
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
  const face = createFace({ size: 168, mood: 'listening', followPointer: false });
  $('[data-talk-face]', root).replaceWith(face.el);
  orb.focus({ preventScroll: true });

  const statusText = () => note || {
    starting: 'Connecting',
    listening: 'Listening',
    hearing: 'Listening',
    thinking: 'Looking that up',
    speaking: 'Speak any time to interrupt',
    muted: 'Microphone off',
    error: 'Voice stopped',
  }[state];

  function paint() {
    if (closed) return;
    panel.dataset.state = state;
    $('[data-talk-status]', root).textContent = statusText();
    $('[data-talk-pill-text]', root).textContent = state === 'hearing' && you ? `“${tail(you, 60)}”` : statusText();
    $('[data-talk-pill]', root).classList.toggle('has-words', state === 'hearing' && !!you);
    $('[data-talk-pill]', root).classList.toggle('is-final', state !== 'hearing' && state !== 'speaking');
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

  /** Back to the resting state once Campus is quiet: listening, looking something up, or muted. */
  const rest = () => {
    if (closed || state === 'error' || state === 'starting') return;
    if (isSpeaking()) setState('speaking');
    else if (muted) setState('muted');
    else if (pending) setState('thinking');
    else setState('listening');
  };

  const announce = (extra = {}) => document.dispatchEvent(new CustomEvent('campus:conversation', { detail: { open: !closed, threadId, minimized, ...extra } }));
  const showAction = (a) => {
    $('[data-talk-actions]', root).insertAdjacentHTML('beforeend', html`<span class="chip ${a.ok ? 'success' : 'danger'}">${icon(a.ok ? 'check' : 'alert', 13)} ${a.ok ? a.title : 'I could not do that'}</span>`.value);
  };

  /** Things an answer asked the browser to do (open a page, change the theme). The server has checked them. */
  function applyEffects(list) {
    for (const effect of list) {
      if (effect.type === 'theme') setTheme(effect.mode === 'system' ? null : effect.mode);
      else if (effect.type === 'open') openLink(effect.url);
      else if (effect.type === 'settings') applySettingsEffect(effect);
      else if (effect.type === 'navigate') {
        minimise();
        navigate(effect.path);
      }
    }
  }

  const ensurePlayer = () => {
    if (!player?.active) player = createLivePlayer({ onSpeaking: rest });
    return player;
  };

  function armQuiet() {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (closed) return;
      // Live voice is billed while it is open, so a forgotten conversation ends itself.
      if (Date.now() - lastWordsAt >= QUIET_LIMIT && !isSpeaking() && !pending) {
        toast('The voice conversation ended after two quiet minutes.', 'info');
        close();
      } else armQuiet();
    }, 10_000);
  }

  /** A question the live model handed over: answer it with the normal assistant and give the result back. */
  async function delegate(mine, id, words, said) {
    pending += 1;
    if (!isSpeaking()) setState('thinking');
    let answer;
    try {
      if (!words) throw Object.assign(new Error('nothing heard'), { status: 0, unheard: true });
      const r = await api.post('/assistant/messages', { prompt: words, thread_id: threadId, mode: 'voice', device: deviceSettings(), heard: detectLanguage(words), spoken: true, live_context: said || undefined });
      if (closed) return;
      if (r.thread?.id && r.thread.id !== threadId) {
        threadId = r.thread.id;
        announce();
      }
      const effects = [];
      for (const a of r.message?.actions || []) {
        showAction(a);
        if (a.ok && a.client) effects.push(a.client);
        face.react(a.ok ? 'happy' : 'confused', 1200);
      }
      applyEffects(effects);
      answer = spokenAnswer(r.message?.content) || 'Done.';
      announce({ answered: true });
    } catch (error) {
      if (closed) return;
      answer = error.unheard ? 'The question was not caught. Ask the user to say it again.'
        : error.status === 429 ? 'The app is busy for a moment. Tell the user to ask again shortly.'
          : error.status === 503 ? 'The app’s assistant is not available right now, so this cannot be looked up.'
            : 'Looking this up failed. Tell the user it could not be checked just now.';
    } finally {
      pending = Math.max(0, pending - 1);
    }
    if (!closed) mine.answer(id, answer);
    lastWordsAt = Date.now();
    rest();
  }

  function connect() {
    you = '';
    reply = '';
    replyAfterYou = false;
    setState('starting');
    ensurePlayer();
    const mine = new LiveSession({
      requestPass: (signal) => api.post('/assistant/live', { thread_id: threadId, device: deviceSettings() }, { signal }),
      onReady() {
        if (closed || live !== mine) return;
        lastWordsAt = Date.now();
        armQuiet();
        if (muted) mine.mute(true);
        rest();
      },
      onAudio(encoded) {
        if (closed || live !== mine) return;
        if (dropping) {
          const gap = Date.now() - lastAudioAt;
          lastAudioAt = Date.now();
          if (gap < 700) return;
          dropping = false;
        }
        lastAudioAt = Date.now();
        ensurePlayer().push(encoded);
      },
      onUserText(text) {
        if (closed || live !== mine || !text) return;
        lastWordsAt = Date.now();
        // Talking over Campus: drop what it has not said yet, at once.
        if (player?.active && player.ahead > 0.4) player.clear();
        you = mine.turn;
        replyAfterYou = false;
        $('[data-talk-you]', root).textContent = `“${tail(you, 200)}”`;
        face.pulse(0.6);
        if (!isSpeaking() && !muted && !pending) setState('hearing');
        else paint();
        if (conversationCommand(you) === 'end') goodbye();
      },
      onReplyText(text) {
        if (closed || live !== mine || !text) return;
        lastWordsAt = Date.now();
        if (!replyAfterYou) {
          reply = '';
          replyAfterYou = true;
          $('[data-talk-actions]', root).replaceChildren();
        }
        reply += text;
        $('[data-talk-reply]', root).textContent = tail(reply);
      },
      onDelegation(id, words, said) {
        if (!closed && live === mine) delegate(mine, id, words, said);
      },
      onEnd(reason, { started }) {
        if (closed || live !== mine) return;
        player?.clear();
        if (!started && reason === 'unavailable') {
          // No access to live voice yet, or no connection: the standard conversation takes over.
          restsUntil = Date.now() + 10 * 60_000;
          setSession({ ai: { ...(session.ai || {}), live: false } });
          teardown();
          toast('Live voice isn’t available right now, so the standard voice is used.', 'info');
          onFallback?.(threadId);
          return;
        }
        if (reason === 'closed') {
          teardown();
          return;
        }
        setState('error', TROUBLE[reason] || TROUBLE.lost);
        face.react('sad', 1800);
      },
    });
    live = mine;
    mine.start();
  }

  /** "Goodbye": let Campus say goodbye, then end. */
  function goodbye() {
    if (byeTimer) return;
    const since = Date.now();
    byeTimer = setInterval(() => {
      if (closed) return;
      const quietFor = Date.now() - Math.max(lastAudioAt, lastWordsAt);
      if ((!isSpeaking() && quietFor > 1200 && Date.now() - since > 1500) || Date.now() - since > 8000) close();
    }, 250);
  }

  function setMuted(flag) {
    muted = flag;
    live?.mute(flag);
    rest();
  }

  function tap() {
    if (state === 'error') retry();
    else if (isSpeaking()) {
      player?.clear();
      dropping = true;
      lastAudioAt = Date.now();
      rest();
    } else if (muted) setMuted(false);
    else face.react('happy', 700);
  }

  function retry() {
    live?.close();
    connect();
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

  /** Remove the view and release everything; the live session itself is closed by close(). */
  function teardown() {
    if (closed) return;
    closed = true;
    clearTimeout(quietTimer);
    clearInterval(byeTimer);
    player?.close();
    offs.forEach((off) => off());
    face.destroy();
    root.remove();
    document.body.classList.remove('talk-open');
    if (resumeWake && wake.enabled) setTimeout(() => wake.resume(), 300);
    if (returnFocus?.isConnected && !minimized) returnFocus.focus?.({ preventScroll: true });
    announce();
    onClose?.();
  }

  function close() {
    if (closed) return;
    const ending = live;
    live = null;
    teardown();
    ending?.close(); // asks for the final usage and closes the connection within a few seconds
  }

  const onKey = (e) => {
    if (minimized || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === ' ' || e.code === 'Space') {
      if (e.target.closest?.('button, a, input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      if (!e.repeat) tap();
    }
  };
  const onLeave = () => live?.end('closed');
  const offs = [
    on(root, 'click', '[data-talk-orb]', () => tap()),
    on(root, 'click', '[data-talk-mute]', () => setMuted(!muted)),
    on(root, 'click', '[data-talk-end]', () => close()),
    on(root, 'click', '[data-talk-minimise]', () => minimise()),
    on(root, 'click', '[data-talk-expand]', () => expand()),
    on(root, 'click', '[data-talk-retry]', () => retry()),
    on(root, 'input', '[data-talk-volume]', (e) => {
      const volume = Number(e.target.value);
      saveVoiceSettings({ volume });
      setSpeechVolume(volume);
      $('[data-talk-volume-label]', root).textContent = `${Math.round(volume * 100)}%`;
    }),
    onStore('session', (patch) => {
      if ('user' in patch && !patch.user) close();
    }),
  ];
  document.addEventListener('keydown', onKey);
  window.addEventListener('pagehide', onLeave);
  offs.push(() => document.removeEventListener('keydown', onKey), () => window.removeEventListener('pagehide', onLeave));

  paint();
  connect();
  announce();
  return { expand, close, minimise };
}
