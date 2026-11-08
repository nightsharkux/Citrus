/**
 * Campus — the assistant. Threaded conversations with streamed answers, cited
 * sources, an animated face that reacts and illustrates, dictation, read-aloud,
 * app-wide "Hey Campus" and a full-screen mode.
 */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api, stream } from '../core/api.js';
import { session, firstName, assistantName, setSession } from '../core/store.js';
import { markdown } from '../core/markdown.js';
import { ago } from '../core/format.js';
import { toast, toastError, menu, prompt, confirm, sheet, copyText } from '../core/ui.js';
import { createFace, faceGroup, watchTyping, faceMark } from '../features/face.js';
import { inferVisual } from '../features/face-visuals.js';
import { wake, dictate, speak, stopSpeaking, voiceProblem } from '../features/voice.js';

const SUGGESTIONS = {
  student: [
    ['calendar', 'What’s on my schedule this week?'],
    ['graduation', 'Help me make a study plan for my courses'],
    ['bulb', 'Explain the Pythagorean theorem step by step'],
    ['compass', 'Where can I find the library opening hours?'],
  ],
  lecturer: [
    ['clipboard', 'Draft three concept-check questions for my next lecture'],
    ['presentation', 'Help me structure a 90-minute lecture'],
    ['message', 'Turn my notes into a clear announcement'],
    ['calendar', 'What do I teach this week?'],
  ],
  admin: [
    ['library', 'What should go into our knowledge library first?'],
    ['shield', 'Checklist for a safe pilot rollout'],
    ['users', 'How do I onboard lecturers smoothly?'],
    ['compass', 'Summarise the semester dates'],
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

function messageView(m) {
  if (m.role === 'user') return html`<div class="msg user"><div class="bubble">${m.content}</div></div>`;
  const citations = new Set((m.sources || []).map((s) => s.n));
  return html`<div class="msg ai">
    <span class="msg-avatar">${faceMark()}</span>
    <div class="msg-body">
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

function welcome() {
  const role = session.user.role;
  return html`<div class="chat-welcome stagger">
    <span data-hero-face></span>
    <h1>Hi ${firstName()}, what can I help with?</h1>
    <p class="muted">Campus knows your courses, your schedule and your university’s approved information.</p>
    <div class="suggestions">${(SUGGESTIONS[role] || SUGGESTIONS.student).map(([glyph, text]) => html`<button class="suggestion" data-suggest="${text}">${icon(glyph, 18)}<span>${text}</span></button>`)}</div>
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
          <header class="chat-head">
            <button class="btn btn-ghost btn-icon chat-history-btn" data-history aria-label="Conversations">${icon('history', 19)}</button>
            <span class="chat-face-slot" data-face-slot></span>
            <div class="grow chat-head-text">
              <h2 class="truncate">${active ? active.title : 'Campus'}</h2>
              <span class="small muted chat-status">${statusLine(ready, data.status)}</span>
            </div>
            <div class="chat-head-actions">
              <button class="btn btn-sm ${handsFree ? 'btn-primary' : ''}" data-wake aria-pressed="${handsFree}" title="Listen for “Hey Campus” on every page">${icon('mic', 15)}<span class="hide-sm">${handsFree ? 'Listening' : 'Hey Campus'}</span></button>
              <button class="btn btn-ghost btn-icon" data-fullscreen aria-label="Full screen" title="Full screen">${icon('maximize', 18)}</button>
              ${active ? html`<button class="btn btn-ghost btn-icon" data-thread-menu aria-label="Conversation options">${icon('more', 19)}</button>` : ''}
            </div>
          </header>
          <div class="chat-log" id="chat-log" aria-live="polite">
            ${data.thread?.messages.length ? data.thread.messages.map(messageView) : welcome()}
          </div>
          <div class="composer-wrap">
            ${ready ? '' : html`<div class="notice warning" style="margin-bottom:10px">${icon('info', 18)}<span>${session.user.role === 'admin' ? html`Campus wakes up once you connect a model in <a href="/admin/ai">AI & knowledge</a>.` : 'Campus is asleep until your administrator connects an AI model.'}</span></div>`}
            <form class="composer" id="composer">
              <textarea name="prompt" rows="1" placeholder="Message Campus…" aria-label="Message Campus" maxlength="4000" ${ready ? '' : 'disabled'}></textarea>
              <div class="composer-actions">
                <button type="button" class="btn btn-ghost btn-icon" data-dictate aria-label="Dictate" title="Dictate" ${ready ? '' : 'disabled'}>${icon('mic', 19)}</button>
                <button class="btn btn-primary btn-icon composer-send" aria-label="Send" ${ready ? '' : 'disabled'}>${icon('arrow-up', 19)}</button>
              </div>
            </form>
            <p class="chat-foot">Campus can make mistakes. Check important details with the linked source.</p>
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
    const autosize = () => {
      field.style.height = 'auto';
      field.style.height = `${Math.min(field.scrollHeight, 200)}px`;
    };
    field.addEventListener('input', () => {
      autosize();
      if (!controller && faces.showingVisual) faces.hideVisual();
    });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    const setSending = (sending) => {
      const btn = $('.composer-send', form);
      render(btn, sending ? icon('stop', 17) : icon('arrow-up', 19));
      btn.setAttribute('aria-label', sending ? 'Stop' : 'Send');
      btn.classList.toggle('is-stop', sending);
    };

    const illustrate = (visual, hold = 0) => {
      clearTimeout(hideTimer);
      if (!visual || session.user.preferences?.visuals === false || !faces.showVisual(visual)) return false;
      if (hold) hideTimer = setTimeout(() => faces.hideVisual(), hold);
      return true;
    };

    async function send(text) {
      const question = text.trim();
      if (!question || controller) return;
      if (!ready) {
        faces.react('confused', 1600);
        return;
      }
      $('.chat-welcome', log)?.remove();
      dropHero();
      faces.hideVisual({ immediate: true });
      log.insertAdjacentHTML('beforeend', messageView({ role: 'user', content: question }).value);
      const holder = document.createElement('div');
      holder.className = 'msg ai is-streaming';
      render(holder, html`<span class="msg-avatar">${faceMark()}</span><div class="msg-body"><div class="prose"><span class="typing"><i></i><i></i><i></i></span></div></div>`);
      log.append(holder);
      scrollDown();
      field.value = '';
      autosize();
      field.blur();
      faces.stopTyping();
      faces.setMood('thinking');

      controller = new AbortController();
      setSending(true);
      let answer = '';
      let visual = null;
      let frame = 0;
      const paint = () => {
        frame = 0;
        render($('.prose', holder), html`${markdown(answer)}<span class="caret"></span>`);
        if (log.scrollHeight - log.scrollTop - log.clientHeight < 160) scrollDown(false);
      };
      try {
        await stream('/assistant/messages', { prompt: question, thread_id: threadId }, {
          signal: controller.signal,
          onEvent(type, payload) {
            if (type === 'thread' && !threadId) {
              threadId = payload.id;
              history.replaceState({}, '', `/assistant/${threadId}`);
              prependThread(payload);
            } else if (type === 'visual') {
              visual = payload;
              illustrate(visual);
            } else if (type === 'delta') {
              if (!answer) faces.setMood('speaking');
              answer += payload.text;
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
              holder.outerHTML = messageView({ role: 'assistant', content: answer, sources: payload.sources || [], visual: finalVisual }).value;
              if (faces.showingVisual) hideTimer = setTimeout(() => faces.hideVisual(), 5200);
              faces.setMood('idle');
              faces.react('happy', THANKS.test(question) ? 2600 : 1400);
              if (wake.enabled) {
                faces.setMood('speaking');
                speak(answer, { onEnd: () => faces.setMood('idle') });
              }
            } else if (type === 'error') {
              throw new Error(payload.message);
            }
          },
        });
      } catch (error) {
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

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (controller) controller.abort();
      else send(field.value);
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
      if (e.key === 'Escape' && isFull() && !document.querySelector('.sheet-backdrop')) setFull(false);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('keydown', onKey);
    if (ctx.query.get('full') === '1') setFull(true);

    // ---- Voice: app-wide wake word routes commands here while this page is open.
    const offWake = wake.onCommand((text) => {
      if (text) {
        send(text);
      } else {
        faces.setMood('listening');
        setTimeout(() => !controller && headFace.mood === 'listening' && faces.setMood('idle'), 8000);
      }
    });
    const offWakeState = wake.onState((state) => {
      const b = $('[data-wake]', root);
      if (!b) return;
      const on_ = wake.enabled;
      b.classList.toggle('btn-primary', on_);
      b.setAttribute('aria-pressed', String(on_));
      const label = b.querySelector('span');
      if (label) label.textContent = on_ ? 'Listening' : 'Hey Campus';
      if (state === 'armed') faces.setMood('listening');
    });

    const offs = [
      on(root, 'click', '[data-suggest]', (e, b) => send(b.dataset.suggest)),
      on(root, 'click', '[data-dictate]', () => {
        faces.setMood('listening');
        dictate((text) => {
          field.value = `${field.value} ${text}`.trim();
          autosize();
          field.focus();
        }, () => faces.setMood('idle'));
      }),
      on(root, 'click', '[data-wake]', async () => {
        const enable = !wake.enabled;
        if (enable && !wake.start(assistantName())) return;
        if (!enable) wake.stop();
        const res = await api.patch('/me', { preferences: { voiceWake: enable } }).catch(() => null);
        if (res) setSession({ user: { ...session.user, preferences: res.user.preferences } });
        toast(enable ? 'Say “Hey Campus” on any page. Answers are read aloud.' : 'Campus stopped listening.', 'info');
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
      on(root, 'click', '[data-copy]', (e, b) => copyText(b.closest('.msg-body').querySelector('.prose').innerText, 'Answer copied')),
      on(root, 'click', '[data-speak]', (e, b) => {
        faces.setMood('speaking');
        speak(b.closest('.msg-body').querySelector('.prose').innerText, { onEnd: () => faces.setMood('idle') });
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

    const initial = ctx.query.get('q');
    if (initial && ready) {
      history.replaceState({}, '', location.pathname);
      send(initial);
    } else if (wake.armed && ready) {
      faces.setMood('listening');
    } else if (matchMedia('(pointer: fine)').matches) {
      field.focus();
    }

    return () => {
      offs.forEach((off) => off());
      offWake();
      offWakeState();
      stopTyping();
      controller?.abort();
      clearTimeout(hideTimer);
      stopSpeaking();
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('keydown', onKey);
      if (isFull()) setFull(false);
      faces.destroy();
    };
  },
};
