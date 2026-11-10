/**
 * After a lecture (/lectures/review/:sessionId).
 *
 *   Lecturer  where it went wrong: the class's minute-by-minute understanding, each stretch where students got lost
 *             with a note on the likely sticking point and what was being said, and the key points picked up.
 *   Student   a private recap: their own path through the lecture, where the class got stuck (and whether they were
 *             lost there too), the key points, and one tap to a quiz or a question to the assistant.
 */
import { html, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session } from '../core/store.js';
import { pageHead, empty } from '../core/components.js';
import { dateTime } from '../core/format.js';

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
      ${keyPoints(points)}
    </div>`;
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
      ${stuck.length ? html`<section class="card flush"><div class="card-head"><h2>Where the class got stuck</h2></div>
        <div class="list">${stuck.map((m) => html`<div class="review-moment"><div class="spread"><strong>Minute ${m.minute}</strong>${m.you ? html`<span class="chip ${m.you === 3 ? 'danger' : 'warning'}">${m.you === 3 ? 'You were lost too' : 'You were unsure too'}</span>` : ''}</div>${m.note ? html`<p class="mt-8">${m.note}</p>` : ''}</div>`)}</div></section>` : ''}
      ${keyPoints(points)}
      ${points.length || stuck.length ? html`<section class="card"><h3>Review</h3>
        <div class="cluster mt-8"><a class="btn btn-primary" href="/quiz/new?topic=${encodeURIComponent(topic)}&count=6">${icon('target', 16)} Quiz me on this lecture</a>
        <a class="btn" href="/assistant?new=1&q=${encodeURIComponent(`Help me review the lecture “${s.title}”. ${points.map((p) => p.text).join(' ')}`)}">${icon('campus', 16)} Ask Campus</a></div></section>` : ''}
      ${!points.length && !stuck.length && !signals ? html`<div class="card">${empty({ icon: 'presentation', title: 'Nothing to review yet', body: 'Key points and trouble spots appear when the lecturer’s microphone was on during the lecture.' })}</div>` : ''}
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
    // The lecturer's page keeps filling in while the AI writes its notes.
    if (data.lecturer && !data.data.session.ended) {
      ctx.live.on('live.moment', () => ctx.refresh());
    }
    return on(root, 'click', '[data-none]', () => {});
  },
};
