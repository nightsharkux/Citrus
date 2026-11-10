/**
 * Live lecture (/live/:courseId).
 *
 *   Student   three large buttons on the phone: following · unsure · lost. Their own last answer is shown; nobody
 *             else sees it, the lecturer sees only totals.
 *   Lecturer  the class pulse (updated live), a minute-by-minute timeline, the prepared notes (pictures and PDFs),
 *             "Listen" (the browser's speech recognition feeds Campus what is being said; nothing is recorded on
 *             the server) and "Ask Campus": type it, or just say "Hey Campus, explain the last thing I said".
 *             Ending the lecture shows where it went badly and offers the transcript as a file on this device.
 */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session, assistantName } from '../core/store.js';
import { pageHead, empty } from '../core/components.js';
import { markdown } from '../core/markdown.js';
import { toast, toastError, confirm } from '../core/ui.js';
import { createAttachments } from '../features/attach.js';
import { createCaptioner, speak, stopSpeaking, voiceProblem, setRecognitionLecture } from '../features/voice.js';
import { time } from '../core/format.js';

const SIGNALS = [
  [1, 'Following', 'I understand', 'check-circle'],
  [2, 'Unsure', 'I’m not sure', 'info'],
  [3, 'Lost', 'I’m lost', 'alert'],
];
const STATUS = {
  quiet: ['Waiting for answers', 'quiet'],
  good: ['The class is following', 'good'],
  watch: ['Some students are unsure', 'watch'],
  trouble: ['Many students are lost', 'trouble'],
};
const isLecturer = () => session.user.role !== 'student';

export default {
  title: 'Live lecture',
  async load(ctx) {
    const courseId = Number(ctx.params.id);
    const active = await api.get(`/live/courses/${courseId}/active`);
    const view = active.session && isLecturer() ? await api.get(`/live/sessions/${active.session.id}`) : null;
    return { courseId, active, view };
  },

  render(d) {
    const course = d.active.course;
    if (!d.active.session) {
      return isLecturer() ? start(d) : html`${pageHead({ back: { href: '/home', label: 'Home' }, title: 'Live lecture' })}
        <div class="card">${empty({ icon: 'presentation', title: 'No lecture is running', body: 'When your lecturer starts the lecture, it appears here and on your home screen.' })}</div>`;
    }
    return html`${pageHead({ back: { href: isLecturer() ? `/courses/${d.courseId}` : '/home', label: isLecturer() ? 'Course' : 'Home' }, title: d.active.session.title, subtitle: course ? `${course.code} · ${course.title}` : '' })}
      ${isLecturer() ? lecturerScreen(d.view) : studentScreen(d.active)}`;
  },

  mount(root, d, ctx) {
    if (!d.active.session) return isLecturer() ? mountStart(root, d, ctx) : mountWaiting(ctx);
    return isLecturer() ? mountLecturer(root, d, ctx) : mountStudent(root, d, ctx);
  },
};

// ------------------------------------------------------------------ student

function studentScreen({ mine }) {
  return html`<div class="live-student">
    <p class="muted center">Tap how you’re following. Change it any time; only totals reach your lecturer.</p>
    <div class="live-buttons">${SIGNALS.map(([level, label, hint, glyph]) => html`
      <button class="live-signal live-signal-${level} ${mine?.level === level ? 'is-active' : ''}" data-signal="${level}" aria-pressed="${mine?.level === level}">
        <span class="live-signal-icon">${icon(glyph, 30)}</span><strong>${label}</strong><span class="small">${hint}</span>
      </button>`)}</div>
    <p class="small muted center" data-signal-note>${mine ? `You said “${SIGNALS[mine.level - 1][1].toLowerCase()}” at ${time(mine.created)}.` : 'You haven’t answered yet.'}</p>
  </div>`;
}

function mountStudent(root, d, ctx) {
  ctx.live.on('live.ended', () => {
    toast('The lecture has ended. Here is your recap.', 'info');
    ctx.navigate(`/lectures/review/${d.active.session.id}`); // their own path, where the class got stuck, the key points
  });
  return on(root, 'click', '[data-signal]', async (e, button) => {
    const level = Number(button.dataset.signal);
    try {
      const r = await api.post(`/live/sessions/${d.active.session.id}/signal`, { level });
      root.querySelectorAll('[data-signal]').forEach((b) => {
        b.classList.toggle('is-active', b === button);
        b.setAttribute('aria-pressed', String(b === button));
      });
      $('[data-signal-note]', root).textContent = `You said “${SIGNALS[level - 1][1].toLowerCase()}” at ${time(r.created)}.`;
      navigator.vibrate?.(20);
    } catch (error) {
      toastError(error);
    }
  });
}

function mountWaiting(ctx) {
  ctx.live.on('live.started', () => ctx.refresh());
  return undefined;
}

// ------------------------------------------------------------------ lecturer: start

function start(d) {
  return html`${pageHead({ back: { href: `/courses/${d.courseId}`, label: 'Course' }, title: 'Start a lecture', subtitle: 'Add your notes first (pictures or PDFs) so Campus can explain from them while you teach.' })}
    <section class="card stack" style="max-width:640px">
      <label class="field"><span>Title</span><input class="input" data-title maxlength="120" placeholder="Week 5: gradient descent"></label>
      <div class="field"><span>Notes</span>
        <div class="att-tray" data-tray hidden></div>
        <button class="btn" data-add-notes>${icon('upload', 16)} Add pictures or PDFs</button>
        <span class="hint">Campus reads text in PDFs, Word, PowerPoint and photos of slides or handwriting. You can add more during the lecture.</span>
      </div>
      <div class="form-actions"><button class="btn btn-primary btn-lg" data-start>${icon('play', 18)} Start lecture</button></div>
    </section>`;
}

function mountStart(root, d, ctx) {
  const attach = createAttachments({ tray: $('[data-tray]', root), onError: (m) => toast(m, 'error') });
  const picker = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true, accept: 'image/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md' });
  root.append(picker);
  picker.addEventListener('change', () => {
    attach.add(picker.files);
    picker.value = '';
  });
  const offs = [
    on(root, 'click', '[data-add-notes]', () => picker.click()),
    on(root, 'click', '[data-start]', async (e, button) => {
      button.disabled = true;
      try {
        await attach.settled();
        const lecture = Number(ctx.query.get('lecture')) || undefined; // chosen from Lectures: start that scheduled lecture
        const body = { course_id: d.courseId, lecture_id: lecture, title: $('[data-title]', root).value.trim(), notes: attach.ready().map((a) => a.id) };
        await api.post('/live/sessions', body);
        attach.sent();
        ctx.refresh();
      } catch (error) {
        button.disabled = false;
        toastError(error);
      }
    }),
  ];
  return () => offs.forEach((off) => off());
}

// ------------------------------------------------------------------ lecturer: running

function pulseCard(p) {
  const [label, tone] = STATUS[p.status];
  const total = Math.max(1, p.answered);
  return html`<div class="live-pulse is-${tone}" data-pulse>
    <div class="live-pulse-head"><span class="live-dot"></span><strong>${label}</strong><span class="small muted">${p.answered} of ${p.enrolled} answered · last 3 min</span></div>
    <div class="bar mt-16"><span class="got" style="width:${(100 * p.following) / total}%"></span><span class="partial" style="width:${(100 * p.unsure) / total}%"></span><span class="lost" style="width:${(100 * p.lost) / total}%"></span></div>
    <div class="live-counts"><span>${p.following} following</span><span>${p.unsure} unsure</span><span>${p.lost} lost</span></div>
  </div>`;
}

const timelineView = (line) => html`<div class="live-line" data-line role="img" aria-label="Minute-by-minute class understanding">${line.map((m) => html`<i class="is-${m.status}" title="Minute ${m.minute}"></i>`)}</div>`;

function lecturerScreen(view) {
  const supported = !voiceProblem();
  return html`<div class="live-grid">
    <div class="stack">
      <section class="card">
        ${pulseCard(view.pulse)}
        <h3 class="mt-24">Through the lecture</h3>
        ${timelineView(view.timeline)}
      </section>
      <section class="card stack">
        <div class="spread"><h3>Ask ${assistantName()}</h3><span class="chip outline" data-heard>${view.heard ? 'Heard recently' : 'Not listening'}</span></div>
        <form class="composer" data-ask-form><textarea name="q" rows="1" maxlength="600" aria-label="Ask" placeholder="Explain the last thing I said"></textarea>
          <div class="composer-actions"><button class="btn btn-primary btn-icon composer-send" aria-label="Ask">${icon('arrow-up', 19)}</button></div></form>
        <div class="live-answer" data-answer hidden></div>
        <p class="small muted">${supported ? `Or say “Hey ${assistantName()}, …” while listening is on.` : voiceProblem()}</p>
      </section>
    </div>
    <div class="stack">
      <section class="card stack">
        <h3>Listening</h3>
        <p class="small muted">${assistantName()} follows what you say so it can answer about it. The lecture is not recorded: only the last few minutes stay in memory on the server, and the full text stays on this device.</p>
        <button class="btn ${supported ? 'btn-primary' : ''}" data-listen ${supported ? '' : 'disabled'}>${icon('mic', 16)} <span>Start listening</span></button>
        <p class="small muted" data-interim aria-live="polite"></p>
        <button class="btn btn-ghost" data-save hidden>${icon('download', 16)} Save transcript to this device</button>
      </section>
      <section class="card stack">
        <h3>Notes</h3>
        <ul class="live-notes" data-notes>${view.notes.map((n) => html`<li>${icon(n.kind === 'image' ? 'image' : 'file', 15)} ${n.name}</li>`)}</ul>
        <div class="att-tray" data-tray hidden></div>
        <button class="btn btn-sm" data-add-notes>${icon('plus', 15)} Add pictures or PDFs</button>
      </section>
      <button class="btn btn-danger" data-end>${icon('stop', 16)} End lecture</button>
    </div>
  </div>`;
}

function mountLecturer(root, d, ctx) {
  const sid = d.active.session.id;
  setRecognitionLecture(sid); // the speech recogniser learns this lecture's terms
  const transcript = []; // the whole lecture, kept only in this page and offered as a file
  let captioner = null;
  let heardAt = 0;

  // ---- live pulse
  ctx.live.on('live.pulse', (event) => {
    if (event.session !== sid) return;
    const card = $('[data-pulse]', root);
    if (card) card.outerHTML = pulseCard(event.pulse).value;
    api.get(`/live/sessions/${sid}`).then((v) => {
      const line = $('[data-line]', root);
      if (line) line.outerHTML = timelineView(v.timeline).value;
      document.body.dataset.livePulse = v.pulse.status;
    }).catch(() => {});
  });
  document.body.dataset.livePulse = d.view.pulse.status;

  // ---- ask
  const answerBox = $('[data-answer]', root);
  async function ask(question) {
    const q = question.trim();
    if (!q) return;
    answerBox.hidden = false;
    render(answerBox, html`<span class="typing"><i></i><i></i><i></i></span>`);
    try {
      const r = await api.post(`/live/sessions/${sid}/ask`, { question: q });
      render(answerBox, html`<div class="prose">${markdown(r.answer)}</div>${r.heard ? '' : html`<p class="small muted">Campus hasn’t heard anything yet. Turn listening on.</p>`}`);
      speak(r.answer);
    } catch (error) {
      render(answerBox, html`<div class="notice danger">${icon('alert', 18)}<span>${error.message}</span></div>`);
    }
  }
  const wakeAsk = () => new RegExp(`(?:^|[\\s,.!?])(?:hey|hay|hi|ok|okay|hallo)?[\\s,]*${assistantName().replace(/[^\p{L}\p{N}]/gu, '')}[\\s,.:!?]+(.{4,})$`, 'i');

  // ---- listening: speech goes to the server's short memory and to this device
  function listen(button) {
    if (captioner?.running) {
      captioner.stop();
      captioner = null;
      render(button, html`${icon('mic', 16)} <span>Start listening</span>`);
      $('[data-interim]', root).textContent = '';
      return;
    }
    captioner = createCaptioner({
      onFinal: (text) => {
        if (!text) return;
        const asked = wakeAsk().exec(text);
        if (asked) {
          ask(asked[1]);
          return;
        }
        transcript.push({ at: Date.now(), text });
        heardAt = Date.now();
        $('[data-heard]', root).textContent = 'Heard recently';
        $('[data-save]', root).hidden = false;
        api.post(`/live/sessions/${sid}/transcript`, { text }).catch(() => {});
      },
      onInterim: (text) => ($('[data-interim]', root).textContent = text),
      onStop: () => stopSpeaking(),
    });
    if (!captioner) return toast(voiceProblem() || 'Listening needs Chrome, Edge or Safari.', 'error');
    captioner.start();
    render(button, html`${icon('stop', 16)} <span>Stop listening</span>`);
  }

  // ---- notes
  const attach = createAttachments({ tray: $('[data-tray]', root), onError: (m) => toast(m, 'error'), onChange: () => {} });
  const picker = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true, accept: 'image/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md' });
  root.append(picker);
  picker.addEventListener('change', async () => {
    attach.add(picker.files);
    picker.value = '';
    try {
      await attach.settled();
      const ids = attach.ready().map((a) => a.id);
      if (!ids.length) return;
      const v = await api.post(`/live/sessions/${sid}/notes`, { attachment_ids: ids });
      attach.sent();
      render($('[data-notes]', root), html`${v.notes.map((n) => html`<li>${icon(n.kind === 'image' ? 'image' : 'file', 15)} ${n.name}</li>`)}`);
      toast('Notes added. Campus can use them now.', 'success', { duration: 2200 });
    } catch (error) {
      toastError(error);
    }
  });

  const download = () => {
    const body = transcript.map((l) => `[${new Date(l.at).toLocaleTimeString()}] ${l.text}`).join('\n');
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([body], { type: 'text/plain' })), download: `${d.active.session.title.replace(/[^\w-]+/g, '-')}-transcript.txt` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  };

  const offs = [
    on(root, 'click', '[data-listen]', (e, b) => listen(b)),
    on(root, 'click', '[data-add-notes]', () => picker.click()),
    on(root, 'click', '[data-save]', download),
    on(root, 'submit', '[data-ask-form]', (e, form) => {
      e.preventDefault();
      ask(form.q.value);
      form.q.value = '';
    }),
    on(root, 'click', '[data-end]', async () => {
      if (!(await confirm({ title: 'End the lecture?', message: 'Students are told it has ended. You can save the transcript to this device first.', confirmLabel: 'End lecture' }))) return;
      captioner?.stop();
      try {
        const summary = await api.post(`/live/sessions/${sid}/end`);
        showSummary(root, summary, transcript.length ? download : null);
      } catch (error) {
        toastError(error);
      }
    }),
  ];
  const quiet = setInterval(() => {
    if (heardAt && Date.now() - heardAt > 90_000) $('[data-heard]', root).textContent = 'Quiet';
  }, 15_000);

  return () => {
    offs.forEach((off) => off());
    clearInterval(quiet);
    captioner?.stop();
    stopSpeaking();
    setRecognitionLecture(null);
    delete document.body.dataset.livePulse;
  };
}

function showSummary(root, s, save) {
  const patches = s.roughPatches;
  const view = html`<section class="card center" style="padding:32px 24px">
    <h2>Lecture ended</h2>
    <p class="muted mt-8">${patches.length ? `The class struggled ${patches.map((p) => (p.from === p.to ? `around minute ${p.from}` : `from minute ${p.from} to ${p.to}`)).join(' and ')}. Worth revisiting.` : 'The class followed without major trouble.'}</p>
    ${timelineView(s.timeline)}
    <div class="cluster mt-24" style="justify-content:center">${save ? html`<button class="btn" data-again>${icon('download', 16)} Save transcript</button>` : ''}<a class="btn btn-primary" href="/lectures/review/${s.session.id}">See where it went wrong</a><a class="btn btn-ghost" href="/home">Back to home</a></div>
  </section>`;
  render(root.querySelector('.live-grid').parentElement, view);
  root.querySelector('[data-again]')?.addEventListener('click', save);
}
