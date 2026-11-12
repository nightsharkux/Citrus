/**
 * After a lecture (/lectures/review/:sessionId).
 *
 *   Lecturer  where it went wrong: the class's minute-by-minute understanding, each stretch where students got lost
 *             with a note on the likely sticking point and what was being said, and the key points picked up.
 *   Student   a private recap: their own path through the lecture, where the class got stuck (and whether they were
 *             lost there too), the key points, and one tap to a quiz or a question to the assistant.
 */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session, assistantName } from '../core/store.js';
import { pageHead, empty } from '../core/components.js';
import { dateTime } from '../core/format.js';
import { markdown } from '../core/markdown.js';
import { busy, confirm, toast, toastError } from '../core/ui.js';
import { FLAGS } from './live.js';

const TONE = { 1: 'good', 2: 'watch', 3: 'trouble' };
const isLecturer = () => session.user.role !== 'student';

const blocks = (cells) => html`<div class="live-line" role="img" aria-label="Minute-by-minute understanding">${cells.map((c) => html`<i class="${c.tone ? `is-${c.tone}` : ''}" title="${c.title}"></i>`)}</div>`;

const keyPoints = (points) => (points.length
  ? html`<section class="card"><h3>Key points</h3><ul class="review-points">${points.map((p) => html`<li><span class="chip outline">${p.minute} min</span> ${p.text}</li>`)}</ul></section>`
  : '');

function lecturerView(d) {
  const { session: s, course, timeline, struggles, points, pulse, answeredBy } = d;
  const hasSpeech = struggles.some((m) => m.excerpt);
  return html`${pageHead({ back: { href: '/lectures', label: 'Lectures' }, title: s.title, subtitle: `${course.code} · ${dateTime(s.started)}` })}
    <div class="stack stagger" style="max-width:760px">
      <section class="card">
        <p><strong>${struggles.length ? `The class got lost ${struggles.length === 1 ? 'once' : `${struggles.length} times`}.` : 'The class followed without major trouble.'}</strong>
          <span class="muted"> ${answeredBy} ${answeredBy === 1 ? 'student' : 'students'} answered${pulse.enrolled ? ` out of ${pulse.enrolled}` : ''}.</span></p>
        <h3 class="mt-24">Through the lecture</h3>
        ${blocks(timeline.map((m) => ({ tone: m.status === 'quiet' ? '' : m.status, title: `Minute ${m.minute}` })))}
        <p class="small muted mt-8">Green: following. Amber: some unsure. Red: many lost. Grey: too few answers to tell.</p>
      </section>
      ${struggles.length ? html`<section class="card flush"><div class="card-head"><h2>Where it got hard</h2></div>
        <div class="list">${struggles.map((m) => html`<div class="review-moment">
          <div class="spread"><strong>Minute ${m.minute}</strong><span class="chip danger">${m.lost} of ${m.answered} lost</span></div>
          ${m.note ? html`<p class="mt-8">${m.note}</p>` : ''}
          ${m.excerpt ? html`<blockquote class="review-quote">${m.excerpt.replace(/^\[\d\d:\d\d\]\s*/, '').replace(/\s*\[\d\d:\d\d\]\s*/g, ' ')}</blockquote>` : ''}
        </div>`)}</div>
        ${hasSpeech ? '' : html`<p class="small muted" style="padding:0 20px 18px">Campus didn’t hear the lecture at these moments. Turn on listening next time to see what was being said.</p>`}</section>` : ''}
      ${lecturerFlags(d.flags)}
      ${keyPoints(points)}
      ${transcriptCard(d)}
    </div>`;
}

const flagLabel = (kind) => (FLAGS[kind] || FLAGS.confused)[0];

/** The moments students flagged, grouped by minute, with what was being said when the transcript was kept. */
function lecturerFlags(flags = []) {
  if (!flags.length) return '';
  const byMinute = new Map();
  for (const f of flags) byMinute.set(f.minute, [...(byMinute.get(f.minute) || []), f]);
  return html`<section class="card flush"><div class="card-head"><h2>What students flagged</h2><span class="chip">${flags.length}</span></div>
    <div class="list">${[...byMinute.entries()].map(([minute, group]) => html`<div class="review-moment">
      <div class="spread"><strong>Minute ${minute}</strong><span class="cluster" style="--gap:6px">${[...new Set(group.map((f) => f.kind))].map((k) => html`<span class="chip outline">${flagLabel(k)} ${group.filter((f) => f.kind === k).length}</span>`)}</span></div>
      ${group.filter((f) => f.note).map((f) => html`<p class="small mt-8">“${f.note}”</p>`)}
      ${group[0].excerpt ? html`<blockquote class="review-quote">${group[0].excerpt.replace(/\[minute \d+\]\s*/g, '')}</blockquote>` : ''}
    </div>`)}</div></section>`;
}

function transcriptCard(d) {
  const s = d.session;
  if (!s.keepTranscript) return html`<p class="small muted">The transcript of this lecture was not kept.</p>`;
  return html`<section class="card"><div class="spread"><div><h3>Transcript</h3><p class="small muted">${d.stored ? `${d.stored} lines heard. Students can ask ${assistantName()} about this lecture; only you can download it.` : 'Nothing was heard during this lecture.'}</p></div>
    ${d.stored ? html`<div class="cluster"><a class="btn btn-sm" href="/api/live/sessions/${s.id}/transcript.txt">${icon('download', 15)} Download .txt</a><button class="btn btn-sm btn-ghost" data-forget>${icon('trash', 15)} Delete</button></div>` : ''}</div></section>`;
}

function myFlags(flags = []) {
  if (!flags.length) return '';
  return html`<section class="card flush"><div class="card-head"><h2>Moments you flagged</h2></div>
    <div class="list">${flags.map((f) => html`<div class="review-moment">
      <div class="spread"><strong>Minute ${f.minute} · ${flagLabel(f.kind)}</strong>${f.explanation ? '' : html`<button class="btn btn-sm" data-explain="${f.id}">${icon('sparkle', 14)} Explain it</button>`}</div>
      ${f.note ? html`<p class="small muted mt-8">“${f.note}”</p>` : ''}
      <div class="prose small mt-8" data-explanation="${f.id}">${f.explanation ? markdown(f.explanation) : ''}</div>
    </div>`)}</div></section>`;
}

function askLecture(d) {
  if (!d.canAsk) return '';
  return html`<section class="card stack"><div><h2>Ask ${assistantName()} about this lecture</h2><p class="small muted">${assistantName()} answers from what was said in the lecture and the lecturer’s notes. Private to you.</p></div>
    <form class="composer" data-ask-form><textarea name="q" rows="1" maxlength="600" aria-label="Question" placeholder="What was the second example about?"></textarea>
      <div class="composer-actions"><button class="btn btn-primary btn-icon composer-send" aria-label="Ask">${icon('arrow-up', 19)}</button></div></form>
    <div class="live-answer" data-answer hidden></div></section>`;
}

function studentView(d) {
  const { session: s, course, mine, classPatches, struggles, points, signals } = d;
  const level = (minute) => mine.find((m) => m.minute === minute)?.level || null;
  const stuck = struggles.map((m) => ({ ...m, you: [level(m.minute), level(m.minute + 1), level(m.minute - 1)].find((l) => l === 3 || l === 2) || null }));
  const topic = [s.title, ...points.slice(0, 2).map((p) => p.text)].join('. ').slice(0, 160);
  return html`${pageHead({ back: { href: '/lectures', label: 'Lectures' }, title: s.title, subtitle: `${course.code} · ${dateTime(s.started)}` })}
    <div class="stack stagger" style="max-width:760px">
      <section class="card">
        <h3>How you followed</h3>
        ${signals ? blocks(mine.map((m) => ({ tone: m.level ? TONE[m.level] : '', title: `Minute ${m.minute}` }))) : ''}
        <p class="small muted mt-8">${signals ? 'Only you can see this. Green: following. Amber: unsure. Red: lost. Grey: no answer.' : 'You didn’t answer during this lecture. Next time, tap how you’re following and this recap will show where you got stuck.'}</p>
      </section>
      ${myFlags(d.flags)}
      ${askLecture(d)}
      ${stuck.length ? html`<section class="card flush"><div class="card-head"><h2>Where the class got stuck</h2></div>
        <div class="list">${stuck.map((m) => html`<div class="review-moment"><div class="spread"><strong>Minute ${m.minute}</strong>${m.you ? html`<span class="chip ${m.you === 3 ? 'danger' : 'warning'}">${m.you === 3 ? 'You were lost too' : 'You were unsure too'}</span>` : ''}</div>${m.note ? html`<p class="mt-8">${m.note}</p>` : ''}</div>`)}</div></section>` : ''}
      ${keyPoints(points)}
      ${points.length || stuck.length ? html`<section class="card"><h3>Review</h3>
        <div class="cluster mt-8"><a class="btn btn-primary" href="/quiz/new?topic=${encodeURIComponent(topic)}&count=6">${icon('target', 16)} Quiz me on this lecture</a>
        <a class="btn" href="/assistant?new=1&q=${encodeURIComponent(`Help me review the lecture “${s.title}”. ${points.map((p) => p.text).join(' ')}`)}">${icon('campus', 16)} Ask Campus</a></div></section>` : ''}
      ${!points.length && !stuck.length && !signals && !d.flags?.length && !d.canAsk ? html`<div class="card">${empty({ icon: 'presentation', title: 'Nothing to review yet', body: 'Key points and trouble spots appear when the lecturer’s microphone was on during the lecture.' })}</div>` : ''}
    </div>`;
}

export default {
  title: 'Lecture review',
  async load(ctx) {
    const id = ctx.params.id;
    return { lecturer: isLecturer(), data: await api.get(`/live/sessions/${id}/${isLecturer() ? 'report' : 'recap'}`) };
  },
  render({ lecturer, data }) {
    return lecturer ? lecturerView(data) : studentView(data);
  },
  mount(root, data, ctx) {
    const sid = data.data.session.id;
    // The lecturer's page keeps filling in while the AI writes its notes.
    if (data.lecturer && !data.data.session.ended) {
      ctx.live.on('live.moment', () => ctx.refresh());
    }
    const offs = [
      on(root, 'click', '[data-explain]', (e, button) => busy(button, async () => {
        const box = $(`[data-explanation="${button.dataset.explain}"]`, root);
        render(box, html`<span class="typing"><i></i><i></i><i></i></span>`);
        try {
          const r = await api.post(`/live/sessions/${sid}/flags/${button.dataset.explain}/explain`);
          render(box, markdown(r.explanation));
          button.remove();
        } catch (error) {
          render(box, '');
          toastError(error);
        }
      })),
      on(root, 'submit', '[data-ask-form]', async (e, form) => {
        e.preventDefault();
        const q = form.q.value.trim();
        if (!q) return;
        form.q.value = '';
        const box = $('[data-answer]', root);
        box.hidden = false;
        render(box, html`<p class="small muted">${q}</p><span class="typing"><i></i><i></i><i></i></span>`);
        try {
          const r = await api.post(`/live/sessions/${sid}/student-ask`, { question: q });
          render(box, html`<p class="small muted">${q}</p><div class="prose mt-8">${markdown(r.answer)}</div>`);
        } catch (error) {
          render(box, html`<div class="notice danger">${icon('alert', 18)}<span>${error.message}</span></div>`);
        }
      }),
      on(root, 'click', '[data-forget]', async () => {
        if (!(await confirm({ title: 'Delete the transcript?', message: `${assistantName()} can no longer answer questions about this lecture. The flags and key points stay.`, confirmLabel: 'Delete', danger: true }))) return;
        try {
          await api.del(`/live/sessions/${sid}/transcript`);
          toast('Transcript deleted', 'success');
          ctx.refresh();
        } catch (error) {
          toastError(error);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  },
};
