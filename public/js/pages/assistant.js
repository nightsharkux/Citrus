/**
 * Campus — the assistant. Threaded conversations with streamed answers (written
 * like a textbook: formulas, steps, tables), cited sources, an animated face that
 * reacts and illustrates, things it does for you (calendar changes, opening pages)
 * with undo, dictation, read-aloud, app-wide "Hey Campus", a full-screen mode and
 * a hands-free voice conversation (the send button while the box is empty).
 */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api, stream } from '../core/api.js';
import { session, firstName, assistantName, setSession } from '../core/store.js';
import { markdown } from '../core/markdown.js';
import { ago } from '../core/format.js';
import { toast, toastError, menu, prompt, confirm, sheet, copyText } from '../core/ui.js';
import { setTheme } from '../shell.js';
import { createFace, faceGroup, watchTyping, faceMark } from '../features/face.js';
import { inferVisual } from '../features/face-visuals.js';
import { wake, dictate, speak, createSpeaker, primeSpeech, stopSpeaking, voiceProblem } from '../features/voice.js';
import { getVoiceSettings } from '../features/voices.js';
import { applySettingsEffect, deviceSettings } from '../features/preferences.js';
import { startConversation, conversationOpen, conversationProblem } from '../features/conversation.js';
import { createAttachments, attachmentList, zoomPicture, watchDrops, pastedFiles, ACCEPT } from '../features/attach.js';

const SUGGESTIONS = {
  student: [
    ['calendar', 'What’s on my schedule this week?'],
    ['graduation', 'Help me make a study plan for my courses'],
    ['bulb', 'Explain the quadratic formula step by step'],
    ['plus', 'Add a study session to my calendar tomorrow at 4 pm'],
  ],
  lecturer: [
    ['clipboard', 'Draft three concept-check questions for my next lecture'],
    ['presentation', 'Help me structure a 90-minute lecture'],
    ['message', 'Turn my notes into a clear announcement'],
    ['plus', 'Block Friday 10:00 to 12:00 for office hours'],
  ],
  admin: [
    ['library', 'What should go into our knowledge library first?'],
    ['shield', 'Checklist for a safe pilot rollout'],
    ['users', 'How do I onboard lecturers smoothly?'],
    ['calendar', 'Open the schedule'],
  ],
};
const THANKS = /\b(thanks|thank you|thx|danke|cheers|great|perfect|awesome)\b/i;

async function load(ctx) {
  const overview = await api.get('/assistant');
  const threadId = ctx.params.id && ctx.query.get('new') !== '1' ? Number(ctx.params.id) : null;
  const thread = threadId ? await api.get(`/assistant/threads/${threadId}`) : null;
  return { ...overview, thread };
}

function sourceList(sources) {
  if (!sources?.length) return '';
  return html`<div class="sources">${sources.map((s) => (s.url
    ? html`<a class="source" id="src-${s.n}" href="${s.url}" target="_blank" rel="noopener noreferrer"><b>${s.n}</b><span class="truncate">${s.title}</span>${s.checkLive ? html`<em>Check live</em>` : ''}${icon('external', 13)}</a>`
    : html`<span class="source" id="src-${s.n}"><b>${s.n}</b><span class="truncate">${s.title}</span>${s.checkLive ? html`<em>Check live</em>` : ''}</span>`))}</div>`;
}

const ACTION_ICON = { 'app.navigate': 'arrow-right', 'app.theme': 'moon' };

/** One thing the assistant did (or could not do) for the user. */
function actionCard(a, messageId, index) {
  const glyph = !a.ok ? 'alert' : a.undone ? 'undo' : ACTION_ICON[a.name] || (a.name.startsWith('calendar.') ? 'calendar' : 'check-circle');
  const state = !a.ok ? 'is-error' : a.undone ? 'is-undone' : '';
  return html`<div class="action-card ${state}" data-action="${index}">
    <span class="action-icon">${icon(glyph, 18)}</span>
    <span class="action-body">
      <strong>${!a.ok ? 'I could not do that' : a.undone ? 'Undone' : a.title}</strong>
      ${a.ok ? (a.detail ? html`<span class="action-detail">${a.detail}</span>` : '') : html`<span class="action-detail">${a.error}</span>`}
      ${a.ok && a.warning && !a.undone ? html`<em class="action-warn">${icon('alert', 13)} ${a.warning}</em>` : ''}
    </span>
    <span class="action-tools">
      ${a.ok && a.link && !a.undone ? html`<a class="btn btn-sm" href="${a.link}">View</a>` : ''}
      ${a.undoable && messageId ? html`<button class="btn btn-sm btn-ghost" data-undo="${index}" data-message="${messageId}">${icon('undo', 14)} Undo</button>` : ''}
    </span>
  </div>`;
}

const actionList = (actions, messageId) => (actions?.length ? html`<div class="actions">${actions.map((a, i) => actionCard(a, messageId, i))}</div>` : '');

function messageView(m) {
  if (m.role === 'user') return html`<div class="msg user"><div class="bubble-stack">${attachmentList(m.attachments)}${m.content ? html`<div class="bubble">${m.content}</div>` : ''}</div></div>`;
  const citations = new Set((m.sources || []).map((s) => s.n));
  return html`<div class="msg ai">
    <span class="msg-avatar">${faceMark()}</span>
    <div class="msg-body" data-raw="${m.content}">
      ${actionList(m.actions, m.id)}
      <div class="prose">${markdown(m.content, { citations })}</div>
      ${sourceList(m.sources)}
      <div class="msg-tools">
        <button class="btn btn-ghost btn-sm" data-copy aria-label="Copy answer" title="Copy">${icon('copy', 15)}</button>
        <button class="btn btn-ghost btn-sm" data-speak aria-label="Read aloud" title="Read aloud">${icon('volume', 15)}</button>
        ${m.visual ? html`<button class="btn btn-ghost btn-sm" data-replay="${JSON.stringify(m.visual)}" title="Show the illustration again">${icon('play', 14)} Illustration</button>` : ''}
      </div>
    </div>
  </div>`;
}

/** Starters from the user's own situation first, then generic ones, four in all. */
function startersFor(role, personal = []) {
  const all = [...personal, ...(SUGGESTIONS[role] || SUGGESTIONS.student)];
  return all.filter(([, text], i) => all.findIndex(([, t]) => t === text) === i).slice(0, 4);
}

function welcome(starters) {
  const role = session.user.role;
  return html`<div class="chat-welcome stagger">
    <span data-hero-face></span>
    <h1>Hi ${firstName()}, what can I help with?</h1>
    <p class="muted">Campus knows your courses, your schedule and your university’s approved information.</p>
    <div class="suggestions">${startersFor(role, starters).map(([glyph, text]) => html`<button class="suggestion" data-suggest="${text}">${icon(glyph, 18)}<span>${text}</span></button>`)}</div>
  </div>`;
}

function threadList(threads, activeId) {
  if (!threads.length) return html`<p class="muted small" style="padding:8px 20px 20px">Your conversations will appear here.</p>`;
  return html`<div class="list thread-list">${threads.map((t) => html`
    <a class="list-row no-icon ${t.id === activeId ? 'is-active' : ''}" href="/assistant/${t.id}">
      <span class="body"><span class="title">${t.title}</span><span class="sub">${ago(t.updated)}</span></span>
    </a>`)}</div>`;
}

const statusLine = (ready, status) => (ready
  ? html`<span class="dot" style="color:var(--success)"></span><span class="chat-status-text">${status.location === 'local' ? 'Running on your university’s server' : 'Online'}</span>`
  : html`<span class="dot" style="color:var(--warning)"></span><span class="chat-status-text">Asleep, no AI model connected</span>`);

export default {
  title: (d) => d.thread?.thread.title || assistantName(),
  layout: 'wide',
  load,
  render(data) {
    const ready = data.status.aiEnabled;
    const active = data.thread?.thread;
    const handsFree = wake.enabled;
    return html`
      <div class="chat">
        <aside class="chat-threads card flush">
          <div class="card-head"><h3>Conversations</h3><a class="btn btn-sm btn-primary" href="/assistant?new=1">${icon('plus', 15)} New</a></div>
          ${threadList(data.threads, active?.id)}
        </aside>
        <section class="chat-main">
          <div class="drop-hint" aria-hidden="true">${icon('upload', 26)}<strong>Drop to attach</strong><span>Pictures, PDFs, Word, PowerPoint, Excel and text files</span></div>
          <header class="chat-head">
            <button class="btn btn-ghost btn-icon chat-history-btn" data-history aria-label="Conversations">${icon('history', 19)}</button>
            <span class="chat-face-slot" data-face-slot></span>
            <div class="grow chat-head-text">
              <h2 class="truncate">${active ? active.title : assistantName()}</h2>
              <span class="small muted chat-status">${statusLine(ready, data.status)}</span>
            </div>
            <div class="chat-head-actions">
              <button class="btn btn-sm ${handsFree ? 'btn-primary' : ''}" data-wake aria-pressed="${handsFree}" title="Listen for “Hey Campus” on every page">${icon('mic', 15)}<span class="hide-sm">${handsFree ? 'Listening' : 'Hey Campus'}</span></button>
              <button class="btn btn-ghost btn-icon" data-fullscreen aria-label="Full screen" title="Full screen">${icon('maximize', 18)}</button>
              ${active ? html`<button class="btn btn-ghost btn-icon" data-thread-menu aria-label="Conversation options">${icon('more', 19)}</button>` : ''}
            </div>
          </header>
          <div class="chat-log" id="chat-log" aria-live="polite">
            ${data.thread?.messages.length ? data.thread.messages.map(messageView) : welcome(data.starters)}
          </div>
          <div class="composer-wrap">
            ${ready ? '' : html`<div class="notice warning" style="margin-bottom:10px">${icon('info', 18)}<span>${session.user.role === 'admin' ? html`Campus wakes up once you connect a model in <a href="/admin/ai">AI & knowledge</a>.` : 'Campus is asleep until your administrator connects an AI model.'}</span></div>`}
            <form class="composer" id="composer">
              <div class="att-tray" hidden></div>
              <button type="button" class="btn btn-ghost btn-icon composer-attach" data-attach aria-label="Attach a picture or file" title="Attach a picture or file" ${ready ? '' : 'disabled'}>${icon('plus', 20)}</button>
              <textarea name="prompt" rows="1" placeholder="Message Campus, or paste a picture" aria-label="Message Campus" maxlength="4000" ${ready ? '' : 'disabled'}></textarea>
              <div class="composer-actions">
                <button type="button" class="btn btn-ghost btn-icon" data-dictate aria-label="Dictate" title="Dictate" ${ready ? '' : 'disabled'}>${icon('mic', 19)}</button>
                <button class="btn btn-primary btn-icon composer-send" aria-label="Send" ${ready ? '' : 'disabled'}>${icon('arrow-up', 19)}</button>
              </div>
            </form>
          </div>
        </section>
      </div>`;
  },

  mount(root, data, ctx) {
    const log = $('#chat-log', root);
    const form = $('#composer', root);
    const field = form.prompt;
    const ready = data.status.aiEnabled;
    let threadId = data.thread?.thread.id || null;
    let controller = null;
    let hideTimer = 0;
    let dictation = null;
    let preparing = false;
    let spokenDraft = false; // the text in the box was dictated, so the answer may be read aloud

    // ---- Pictures and documents: add by button, paste or drop. They upload as soon as they are added.
    const sendButton = $('.composer-send', form);
    const attach = createAttachments({
      tray: $('.att-tray', form),
      onChange: () => {
        form.classList.toggle('has-files', attach.count > 0);
        syncSend();
      },
      onError: (message) => toast(message, 'error'),
    });

    // ---- The send button starts a voice conversation while there is nothing to send.
    const canTalk = ready && !conversationProblem();
    let talkMode = null;
    function syncSend() {
      if (controller) return;
      const next = canTalk && !field.value.trim() && !attach.count;
      if (next === talkMode) return;
      talkMode = next;
      render(sendButton, icon(next ? 'waveform' : 'arrow-up', 19));
      sendButton.setAttribute('aria-label', next ? 'Talk to Campus' : 'Send');
      sendButton.title = next ? 'Talk to Campus: a hands-free voice conversation' : 'Send';
    }
    const talk = () => {
      dictation?.stop();
      stopSpeaking();
      startConversation({ threadId });
    };
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.hidden = true;
    form.append(picker);
    picker.addEventListener('change', () => {
      attach.add(picker.files);
      picker.value = '';
      if (matchMedia('(pointer: fine)').matches) field.focus();
    });
    const choose = (accept, capture) => {
      picker.accept = accept;
      if (capture) picker.setAttribute('capture', 'environment');
      else picker.removeAttribute('capture');
      picker.click();
    };
    const touch = matchMedia('(pointer: coarse)').matches;
    const offDrops = watchDrops($('.chat-main', root), $('.drop-hint', root), (files) => ready && attach.add(files));
    const onPaste = (e) => {
      const files = pastedFiles(e);
      if (!files.length || !ready) return;
      const target = e.target;
      if (target !== field && target.closest?.('input, textarea, [contenteditable]')) return;
      e.preventDefault();
      attach.add(files);
    };
    document.addEventListener('paste', onPaste);

    // ---- Faces: one in the header (grows into an illustration stage), one large on the welcome screen.
    const headFace = createFace({ size: 44, mood: ready ? 'idle' : 'asleep' });
    headFace.el.classList.add('can-stage');
    $('[data-face-slot]', root).replaceWith(headFace.el);
    const faces = faceGroup(headFace);
    let heroFace = null;
    const heroSlot = $('[data-hero-face]', root);
    if (heroSlot) {
      heroFace = faces.add(createFace({ size: 116, mood: ready ? 'idle' : 'asleep' }));
      heroSlot.replaceWith(heroFace.el);
    }
    const dropHero = () => {
      if (!heroFace) return;
      faces.remove(heroFace);
      heroFace = null;
    };
    const stopTyping = watchTyping(field, faces);

    const scrollDown = (smooth = true) => log.scrollTo({ top: log.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    scrollDown(false);
    // Newer browsers size the box themselves (css: field-sizing). Elsewhere, resize once per frame, not per key.
    const nativeSizing = CSS.supports?.('field-sizing', 'content');
    let sizeFrame = 0;
    const autosize = () => {
      if (nativeSizing || sizeFrame) return;
      sizeFrame = requestAnimationFrame(() => {
        sizeFrame = 0;
        field.style.height = 'auto';
        field.style.height = `${Math.min(field.scrollHeight, 200)}px`;
      });
    };
    field.addEventListener('input', () => {
      autosize();
      syncSend();
      if (!field.value.trim()) spokenDraft = false;
      if (!controller && faces.showingVisual) faces.hideVisual();
    });
    let lastQuestion = [...(data.thread?.messages || [])].reverse().find((m) => m.role === 'user' && m.content)?.content || '';
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      } else if (e.key === 'ArrowUp' && !field.value && lastQuestion) {
        // Like a terminal: Up brings back your last message to edit and send again.
        e.preventDefault();
        field.value = lastQuestion;
        autosize();
      } else if (e.key === 'Escape' && controller) {
        controller.abort();
      }
    });

    const setSending = (sending) => {
      sendButton.classList.toggle('is-stop', sending);
      talkMode = null;
      if (!sending) {
        syncSend();
        return;
      }
      render(sendButton, icon('stop', 17));
      sendButton.setAttribute('aria-label', 'Stop');
      sendButton.title = 'Stop';
    };

    const illustrate = (visual, hold = 0) => {
      clearTimeout(hideTimer);
      if (!visual || session.user.preferences?.visuals === false || !faces.showVisual(visual)) return false;
      if (hold) hideTimer = setTimeout(() => faces.hideVisual(), hold);
      return true;
    };

    /** Things the assistant asked the browser itself to do. The server has already checked them. */
    function runClientEffect(effect) {
      if (effect.type === 'theme') setTheme(effect.mode === 'system' ? null : effect.mode);
      else if (effect.type === 'navigate') ctx.navigate(effect.path);
      else if (effect.type === 'settings') applySettingsEffect(effect);
    }

    /** `spoken`: the question was said, not typed; with the default read-aloud setting the answer is then spoken as it arrives. */
    async function send(text, { spoken = false } = {}) {
      if (controller || preparing) return;
      if (!ready) {
        faces.react('confused', 1600);
        return;
      }
      if (attach.uploading) {
        preparing = true;
        sendButton.classList.add('is-busy');
        await attach.settled();
        sendButton.classList.remove('is-busy');
        preparing = false;
      }
      const question = text.trim();
      const files = attach.ready();
      if (!question && !files.length) return;
      if (question) lastQuestion = question;
      $('.chat-welcome', log)?.remove();
      dropHero();
      faces.hideVisual({ immediate: true });
      log.insertAdjacentHTML('beforeend', messageView({ role: 'user', content: question, attachments: files }).value);
      const holder = document.createElement('div');
      holder.className = 'msg ai is-streaming';
      render(holder, html`<span class="msg-avatar">${faceMark()}</span><div class="msg-body"><div class="actions" hidden></div><div class="prose"><span class="typing"><i></i><i></i><i></i></span></div></div>`);
      log.append(holder);
      scrollDown();
      field.value = '';
      spokenDraft = false;
      autosize();
      field.blur();
      faces.stopTyping();
      faces.setMood('thinking');

      controller = new AbortController();
      setSending(true);
      let answer = '';
      let visual = null;
      let frame = 0;
      const results = [];
      // Read aloud while the answer is being written: "When I speak to Campus" (default), "Every answer" or "Never".
      const readAloud = getVoiceSettings().readAloud;
      let afterSpeech = null;
      const speaker = readAloud === 'always' || (readAloud === 'spoken' && spoken)
        ? createSpeaker({
          onStart: () => faces.setMood('speaking'),
          onEnd: () => {
            if (!controller) faces.setMood('idle');
            const run = afterSpeech;
            afterSpeech = null;
            run?.();
          },
        })
        : null;
      const paint = () => {
        frame = 0;
        render($('.prose', holder), html`${markdown(answer, { streaming: true })}<span class="caret"></span>`);
        if (log.scrollHeight - log.scrollTop - log.clientHeight < 160) scrollDown(false);
      };
      try {
        await stream('/assistant/messages', { prompt: question, thread_id: threadId, attachments: files.map((a) => a.id), device: deviceSettings() }, {
          signal: controller.signal,
          onEvent(type, payload) {
            if (type === 'thread') attach.sent();
            if (type === 'thread' && !threadId) {
              threadId = payload.id;
              history.replaceState({}, '', `/assistant/${threadId}`);
              prependThread(payload);
            } else if (type === 'action') {
              results.push(payload);
              const box = $('.actions', holder);
              if (box) {
                box.hidden = false;
                box.insertAdjacentHTML('beforeend', actionCard(payload, null, results.length - 1).value);
              }
              faces.react(payload.ok ? 'happy' : 'confused', 1200);
              scrollDown();
            } else if (type === 'visual') {
              visual = payload;
              illustrate(visual);
            } else if (type === 'delta') {
              if (!answer) faces.setMood('speaking');
              answer += payload.text;
              speaker?.feed(payload.text);
              if (!visual && answer.length > 160) {
                visual = inferVisual(question, answer) || false;
                if (visual) illustrate(visual);
              }
              if (!frame) frame = requestAnimationFrame(paint);
            } else if (type === 'done') {
              if (visual === null && answer.length > 120) {
                visual = inferVisual(question, answer) || false;
                if (visual) illustrate(visual);
              }
              const finalVisual = payload.visual || visual || null;
              holder.outerHTML = messageView({ id: payload.messageId, role: 'assistant', content: answer, sources: payload.sources || [], visual: finalVisual, actions: payload.actions || results }).value;
              if (faces.showingVisual) hideTimer = setTimeout(() => faces.hideVisual(), 5200);
              faces.react('happy', THANKS.test(question) ? 2600 : 1400);
              const effects = (payload.actions || results).filter((a) => a.ok && a.client).map((a) => a.client);
              const applyEffects = () => effects.forEach(runClientEffect);
              if (speaker?.active) {
                // Open the page or switch the theme once Campus has finished saying so.
                afterSpeech = applyEffects;
                speaker.end();
              } else {
                faces.setMood('idle');
                if (effects.length) setTimeout(applyEffects, effects.some((e) => e.type === 'navigate') ? 1100 : 0);
              }
            } else if (type === 'error') {
              throw new Error(payload.message);
            }
          },
        });
      } catch (error) {
        afterSpeech = null;
        speaker?.cancel();
        faces.hideVisual();
        faces.setMood('idle');
        if (error.name === 'AbortError') {
          faces.react('surprised', 900);
          if (answer) holder.outerHTML = messageView({ role: 'assistant', content: `${answer}\n\n*Stopped.*`, sources: [] }).value;
          else holder.remove();
        } else {
          faces.react('sad', 2600);
          holder.classList.remove('is-streaming');
          render($('.msg-body', holder), html`<div class="notice danger">${icon('alert', 18)}<span>${error.message}</span></div>`);
          if (error.status === 503) setSession({ ai: { ...(session.ai || {}), aiEnabled: false } });
        }
      } finally {
        speaker?.end(); // the stream ended without a `done` event: say what arrived
        cancelAnimationFrame(frame);
        controller = null;
        setSending(false);
        scrollDown();
        if (matchMedia('(pointer: fine)').matches) field.focus();
      }
    }

    function prependThread(t) {
      const container = $('.chat-threads', root);
      let list = $('.thread-list', container);
      if (!list) {
        container.querySelector('p')?.remove();
        list = document.createElement('div');
        list.className = 'list thread-list';
        container.append(list);
      }
      list.querySelectorAll('.is-active').forEach((a) => a.classList.remove('is-active'));
      list.insertAdjacentHTML('afterbegin', html`<a class="list-row no-icon is-active" href="/assistant/${t.id}"><span class="body"><span class="title">${t.title}</span><span class="sub">just now</span></span></a>`.value);
    }

    // Only a click on the button starts talking; Enter in an empty box does nothing.
    sendButton.addEventListener('click', (e) => {
      if (!talkMode || controller) return;
      e.preventDefault();
      talk();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (controller) controller.abort();
      else {
        if (spokenDraft) primeSpeech();
        send(field.value, { spoken: spokenDraft });
      }
    });

    // ---- Full screen
    const isFull = () => document.body.classList.contains('chat-fullscreen');
    const setFull = (full) => {
      document.body.classList.toggle('chat-fullscreen', full);
      const b = $('[data-fullscreen]', root);
      render(b, icon(full ? 'minimize' : 'maximize', 18));
      b.setAttribute('aria-label', full ? 'Exit full screen' : 'Full screen');
      b.title = full ? 'Exit full screen (Esc)' : 'Full screen';
      if (full && document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      if (!full && document.fullscreenElement) document.exitFullscreen().catch(() => {});
      requestAnimationFrame(() => scrollDown(false));
    };
    const onFullscreenChange = () => {
      if (!document.fullscreenElement && isFull()) setFull(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && isFull() && !document.querySelector('.sheet-backdrop') && !conversationOpen()) setFull(false);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('keydown', onKey);
    if (ctx.query.get('full') === '1') setFull(true);

    // ---- Voice: app-wide wake word routes commands here while this page is open.
    const offWake = wake.onCommand((text) => send(text, { spoken: true }));
    // A voice conversation saves into a thread; show it here once it ends (or after each answer while it is shrunk to a pill).
    const onConversation = (e) => {
      const { open, threadId: spokenIn, answered, minimized } = e.detail || {};
      if (!spokenIn || (open && !(answered && minimized))) return;
      if (location.pathname === `/assistant/${spokenIn}`) ctx.refresh();
      else ctx.navigate(`/assistant/${spokenIn}`);
    };
    document.addEventListener('campus:conversation', onConversation);
    const offWakeState = wake.onState((state) => {
      const b = $('[data-wake]', root);
      if (b) {
        const on_ = wake.enabled;
        b.classList.toggle('btn-primary', on_);
        b.setAttribute('aria-pressed', String(on_));
        const label = b.querySelector('span');
        if (label) label.textContent = on_ ? 'Listening' : 'Hey Campus';
      }
      if (controller) return;
      if (state === 'heard' || state === 'armed') faces.setMood('listening');
      else if (headFace.mood === 'listening') faces.setMood('idle');
    });
    // "Stop" (spoken, or Esc while it talks) also ends a running answer.
    const onStop = () => {
      controller?.abort();
      faces.setMood('idle');
    };
    document.addEventListener('campus:stop', onStop);

    const offs = [
      on(root, 'click', '[data-suggest]', (e, b) => send(b.dataset.suggest)),
      on(root, 'click', '[data-attach]', (e, b) => menu(b, [
        { label: 'Upload a picture', hint: 'Photo, screenshot or diagram', icon: 'image', onSelect: () => choose(ACCEPT.picture) },
        { label: 'Upload a document', hint: 'PDF, Word, PowerPoint, Excel, text', icon: 'file', onSelect: () => choose(ACCEPT.document) },
        ...(touch ? [{ label: 'Take a photo', hint: 'Use the camera', icon: 'camera', onSelect: () => choose(ACCEPT.picture, true) }] : []),
      ], { above: true, align: 'start' })),
      on(root, 'click', '[data-zoom]', (e, b) => zoomPicture(b.dataset.zoom, b.dataset.name)),
      on(root, 'click', '[data-dictate]', (e, b) => {
        if (dictation) {
          dictation.stop();
          return;
        }
        const before = field.value.trim();
        const join = (t) => [before, t].filter(Boolean).join(' ');
        faces.setMood('listening');
        b.classList.add('is-recording');
        b.setAttribute('aria-pressed', 'true');
        dictation = dictate({
          // The words appear as you say them, so there is nothing to wait for.
          onInterim: (t) => {
            field.value = join(t);
            autosize();
            syncSend();
          },
          onFinal: (t) => {
            field.value = join(t);
            autosize();
            syncSend();
            spokenDraft = !!t;
            // With "Hey Campus" on, speaking is hands-free: send it.
            if (wake.enabled && t) send(field.value, { spoken: true });
            else field.focus();
          },
          onEnd: () => {
            dictation = null;
            b.classList.remove('is-recording');
            b.setAttribute('aria-pressed', 'false');
            if (!controller) faces.setMood('idle');
          },
        });
      }),
      on(root, 'click', '[data-undo]', async (e, b) => {
        b.disabled = true;
        try {
          const res = await api.post(`/assistant/messages/${b.dataset.message}/actions/${b.dataset.undo}/undo`);
          const card = b.closest('.action-card');
          card.outerHTML = actionCard(res.action, null, Number(b.dataset.undo)).value;
          if (res.action.client?.type === 'settings') applySettingsEffect(res.action.client);
          toast('Undone', 'success', { duration: 1800 });
        } catch (error) {
          b.disabled = false;
          toastError(error);
        }
      }),
      on(root, 'click', '[data-wake]', async () => {
        const enable = !wake.enabled;
        if (enable && !wake.start(assistantName())) return;
        if (!enable) wake.stop();
        const res = await api.patch('/me', { preferences: { voiceWake: enable } }).catch(() => null);
        if (res) setSession({ user: { ...session.user, preferences: res.user.preferences } });
        toast(enable ? `Say “Hey ${assistantName()}” on any page. Answers are read aloud.` : `${assistantName()} stopped listening.`, 'info');
      }),
      on(root, 'click', '[data-fullscreen]', () => setFull(!isFull())),
      on(root, 'click', '.face', () => {
        if (faces.showingVisual) faces.hideVisual();
        else if (!ready) toast('Campus is asleep until an AI model is connected.', 'info');
        else faces.react('happy', 900);
      }),
      on(root, 'click', '[data-replay]', (e, b) => {
        try {
          if (session.user.preferences?.visuals === false) toast('Animated explanations are off. Turn them on in Settings → Assistant.', 'info');
          else if (!illustrate(JSON.parse(b.dataset.replay), 7000)) toast('This illustration isn’t available.', 'info');
          else headFace.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch {
          /* malformed */
        }
      }),
      on(root, 'click', '[data-copy]', (e, b) => copyText(b.closest('.msg-body').dataset.raw || b.closest('.msg-body').querySelector('.prose').innerText, 'Answer copied')),
      on(root, 'click', '[data-speak]', (e, b) => {
        faces.setMood('speaking');
        speak(b.closest('.msg-body').dataset.raw || b.closest('.msg-body').querySelector('.prose').innerText, { onEnd: () => faces.setMood('idle') });
      }),
      on(root, 'click', '.cite', (e, a) => {
        e.preventDefault();
        const src = a.closest('.msg-body').querySelector(`#src-${a.dataset.cite}`);
        src?.classList.add('is-flash');
        src?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setTimeout(() => src?.classList.remove('is-flash'), 1200);
      }),
      on(root, 'click', '[data-history]', () => sheet({
        title: 'Conversations',
        content: html`<a class="btn btn-primary btn-block" href="/assistant?new=1">${icon('plus', 16)} New conversation</a><div class="mt-16">${threadList(data.threads, threadId)}</div>`,
        onMount: (el, close) => el.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => close())),
      })),
      on(root, 'click', '[data-thread-menu]', (e, b) => menu(b, [
        { label: 'Rename', icon: 'edit', onSelect: async () => {
          const title = await prompt({ title: 'Rename conversation', label: 'Title', value: data.thread.thread.title });
          if (!title) return;
          await api.patch(`/assistant/threads/${threadId}`, { title }).catch(toastError);
          ctx.refresh();
        } },
        { label: 'Delete', icon: 'trash', danger: true, onSelect: async () => {
          if (!(await confirm({ title: 'Delete this conversation?', message: 'This can’t be undone.', confirmLabel: 'Delete', danger: true }))) return;
          await api.del(`/assistant/threads/${threadId}`).catch(toastError);
          ctx.navigate('/assistant?new=1');
        } },
      ])),
    ];

    const problem = voiceProblem();
    if (problem) $('[data-dictate]', root)?.setAttribute('title', problem);

    syncSend();
    const initial = ctx.query.get('q');
    if (initial && ready) {
      history.replaceState({}, '', location.pathname);
      send(initial, { spoken: ctx.query.get('spoken') === '1' });
    } else if (wake.armed && ready) {
      faces.setMood('listening');
    } else if (matchMedia('(pointer: fine)').matches) {
      field.focus();
    }

    return () => {
      offs.forEach((off) => off());
      offWake();
      offWakeState();
      document.removeEventListener('campus:stop', onStop);
      document.removeEventListener('campus:conversation', onConversation);
      dictation?.stop();
      offDrops();
      document.removeEventListener('paste', onPaste);
      attach.clear();
      stopTyping();
      controller?.abort();
      clearTimeout(hideTimer);
      if (!conversationOpen()) stopSpeaking(); // a voice conversation outlives the page
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('keydown', onKey);
      if (isFull()) setFull(false);
      faces.destroy();
    };
  },
};
