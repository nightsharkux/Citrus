/**
 * The term so far (/courses/:id/progress), from every finished lecture of the course (src/modules/live/term.js).
 *
 *   Lecturer  Term overview: how well each lecture landed and the trend, each topic of the course from weakest to
 *             strongest, the parts that went worst across all lectures (each opens the lecture's review at that
 *             part), and the students who chose to show their name. Ask Citrus about the whole term in one tap.
 *   Student   My progress: their own results next to the class, lecture by lecture, and every part they found hard
 *             in one list to work through, with a quiz on all of them or on one, and Citrus to explain each.
 *
 * Both download as a tagged .txt with instructions any AI can follow.
 */
import { html, raw, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { assistantName } from '../core/store.js';
import { pageHead, empty } from '../core/components.js';
import { shortDate, plural } from '../core/format.js';
import { busy, toast, toastError } from '../core/ui.js';
import { COLORS } from '../features/lecture-chart.js';

const STATUS = { good: ['success', 'Going well'], watch: ['warning', 'Some unsure'], trouble: ['danger', 'Many lost'], quiet: ['outline', 'Too few answers'] };
const YOU = { following: ['success', 'You followed'], unsure: ['warning', 'You were unsure'], lost: ['danger', 'You were lost'] };
const BAR = { good: COLORS.following, watch: COLORS.unsure, trouble: COLORS.lost, quiet: COLORS.quiet };
const pct = (n) => (n === null || n === undefined ? '–' : `${n}%`);
const statusOf = (p) => (p === null || p === undefined ? 'quiet' : p <= 60 ? 'trouble' : p <= 80 ? 'watch' : 'good');
const chip = (status) => {
  const [tone, word] = STATUS[status] || STATUS.quiet;
  return html`<span class="chip ${tone}">${word}</span>`;
};
const meter = (value) => html`<div class="review-meter" role="img" aria-label="${value === null ? 'Too few answers' : `${value}% understood`}"><i class="is-${statusOf(value)}" style="width:${value ?? 0}%"></i></div>`;
const askHref = (courseId, q, lecture = null) => `/assistant?new=1&course=${courseId}${lecture ? `&lecture=${lecture}` : ''}&q=${encodeURIComponent(q)}`;
const reviewHref = (session, part) => `/lectures/review/${session}${part ? `?part=${part}` : ''}`;

function trendTile(trend) {
  if (!trend) return html`<div class="review-stat"><span class="review-big">–</span><span class="small muted">Trend (after four lectures)</span></div>`;
  const word = { rising: 'Rising', steady: 'Steady', falling: 'Falling' }[trend.direction];
  const tone = { rising: 'is-good', steady: '', falling: 'is-trouble' }[trend.direction];
  return html`<div class="review-stat ${tone}"><span class="review-big">${trend.change > 0 ? '+' : ''}${trend.change}</span><span class="small muted">${word}: last three lectures against the three before</span></div>`;
}

/**
 * One bar per lecture, as tall as its understood %, coloured by status, with the 60 % and 80 % lines. With `you`,
 * the student's own bars only (a student is never shown how the class did). Each bar opens that lecture's review.
 */
function termChart(lectures, { you = false } = {}) {
  if (!lectures.length) return '';
  const W = 720;
  const H = 210;
  const left = 34;
  const right = 8;
  const top = 12;
  const plotH = 150;
  const n = lectures.length;
  const slot = (W - left - right) / n;
  const bw = Math.min(46, slot * 0.62);
  const y = (v) => top + plotH - (v / 100) * plotH;
  const out = [`<svg class="lecture-chart term-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${you ? 'How you followed, lecture by lecture' : 'How each lecture landed'}" xmlns="http://www.w3.org/2000/svg">`];
  for (const v of [0, 60, 80, 100]) out.push(`<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" class="lc-grid"${v === 60 || v === 80 ? ' stroke-dasharray="4 4"' : ''}/><text x="${left - 6}" y="${y(v) + 4}" class="lc-axis" text-anchor="end">${v}%</text>`);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  lectures.forEach((l, i) => {
    const cx = left + slot * i + slot / 2;
    const bar = (x, value, color, label) => (value === null || value === undefined
      ? `<rect x="${x.toFixed(1)}" y="${top + plotH - 2}" width="${bw.toFixed(1)}" height="2" fill="${COLORS.quiet}" fill-opacity="0.6"><title>${esc(label)}: too few answers</title></rect>`
      : `<rect x="${x.toFixed(1)}" y="${y(value).toFixed(1)}" width="${bw.toFixed(1)}" height="${(top + plotH - y(value)).toFixed(1)}" rx="3" fill="${color}"><title>${esc(label)}: ${value}% understood</title></rect>`);
    const date = shortDate(l.date);
    out.push(`<g class="term-bar" data-go="${reviewHref(l.session)}" role="link" tabindex="0" aria-label="${esc(`${l.title}, ${date}`)}">`);
    if (you) {
      out.push(bar(cx - bw / 2, l.answered ? l.you : null, BAR[statusOf(l.answered ? l.you : null)], `${l.title} · you`));
    } else {
      out.push(bar(cx - bw / 2, l.understood, BAR[l.status] || COLORS.quiet, `${l.title} · ${date}`));
      if (l.flags) out.push(`<path d="M${cx.toFixed(1)} ${top + plotH + 6} l5 9 h-10 z" fill="${COLORS.flag}"><title>${l.flags} ${l.flags === 1 ? 'flag' : 'flags'}</title></path>`);
    }
    if (n <= 16 || i % Math.ceil(n / 12) === 0) out.push(`<text x="${cx.toFixed(1)}" y="${H - 8}" class="lc-axis" text-anchor="middle">${esc(date.replace(/,? \d{4}$/, ''))}</text>`);
    out.push('</g>');
  });
  out.push('</svg>');
  return raw(out.join(''));
}

// ---- lecturer

function termView(d) {
  const a = d.averages;
  const name = assistantName();
  const tile = (value, label, tone = '') => html`<div class="review-stat ${tone}"><span class="review-big">${value}</span><span class="small muted">${label}</span></div>`;
  const askTerm = askHref(d.course.id, `About my course ${d.course.code} ${d.course.title} so far: which topics and parts should I revisit, and how should I explain them differently?`);
  return html`
    ${pageHead({
      back: { href: `/courses/${d.course.id}`, label: d.course.code },
      title: 'Term overview',
      subtitle: html`${d.course.title} · ${plural(a.lectures, 'lecture')} so far`,
      actions: html`<a class="btn btn-primary" href="${askTerm}">${icon('campus', 17)} Ask ${name} about the term</a>
        <a class="btn" href="/api/courses/${d.course.id}/progress.txt" download>${icon('download', 17)} For AI (.txt)</a>`,
    })}
    ${!a.lectures ? html`<div class="card">${empty({ icon: 'trending', title: 'No finished lectures yet', body: 'After your first live lecture, this page shows how each lecture landed, which topics need another look and the parts students found hardest.', action: html`<a class="btn btn-primary" href="/live/${d.course.id}">Start a live lecture</a>` })}</div>` : html`
    <div class="stack stagger">
      <section class="review-stats">
        ${tile(pct(a.term), 'Understood, across the term', a.status === 'quiet' ? '' : `is-${a.status}`)}
        ${tile(a.lectures, a.lectures === 1 ? 'Lecture' : 'Lectures')}
        ${tile(a.flags, a.flags === 1 ? 'Flag from students' : 'Flags from students', a.flags ? 'is-flag' : '')}
        ${trendTile(d.trend)}
      </section>
      <section class="card review-chart-card"><div class="spread"><h2>Lecture by lecture</h2><span class="small muted">Tap a lecture for its review</span></div>
        <div class="lecture-chart-wrap">${termChart(d.lectures)}</div>
        <div class="chart-legend"><span><i style="background:${COLORS.following}"></i>Above 80 %</span><span><i style="background:${COLORS.unsure}"></i>61–80 %</span><span><i style="background:${COLORS.lost}"></i>60 % or less</span><span><i style="background:${COLORS.flag}"></i>Flags</span></div>
      </section>
      ${topicsCard(d)}
      ${hardestCard(d)}
      ${d.students.length ? namedCard(d) : ''}
      ${lecturesCard(d)}
    </div>`}`;
}

function topicsCard(d) {
  if (d.topics.length < 2 && d.topics[0]?.id === null) return '';
  return html`<section class="card flush"><div class="card-head"><h2>Topics, weakest first</h2><span class="small muted">From the course content</span></div>
    <div class="list">${d.topics.map((t) => html`<div class="term-row">
      <div class="spread"><strong>${t.title}</strong>${chip(t.status)}</div>
      ${meter(t.understood)}
      <div class="spread mt-4"><span class="small muted">${pct(t.understood)} understood · ${plural(t.lectures, 'lecture')}${t.flags ? ` · ${plural(t.flags, 'flag')}` : ''}</span>
        <a class="btn btn-sm btn-ghost" href="${askHref(d.course.id, `How did the topic “${t.title}” go in ${d.course.code}, and what should I do about it?`)}">${icon('campus', 14)} Ask ${assistantName()}</a></div>
    </div>`)}</div></section>`;
}

function hardestCard(d) {
  return html`<section class="card flush"><div class="card-head"><h2>Hardest parts of the term</h2><span class="chip">${d.hardest.length}</span></div>
    ${d.hardest.length ? html`<div class="list">${d.hardest.map((h) => html`<div class="term-row">
      <div class="spread"><span class="small muted">${shortDate(h.date)} · ${h.lecture}</span>${chip(h.status)}</div>
      <p class="mt-4"><strong>${h.part} · ${h.at}</strong> ${h.title}</p>
      <p class="small muted mt-4">${pct(h.understood)} understood${h.flags ? ` · ${plural(h.flags, 'flag')}` : ''}${h.struggles ? ` · the class got lost ${h.struggles === 1 ? 'once' : `${h.struggles} times`}` : ''} · ${h.topic}</p>
      <div class="cluster mt-8"><a class="btn btn-sm" href="${reviewHref(h.session, h.part)}">${icon('eye', 14)} Open the moment</a>
        <a class="btn btn-sm btn-ghost" href="${askHref(d.course.id, `How could I explain ${h.part} (${h.at}, “${h.title}”) of my lecture “${h.lecture}” better? Use what students flagged and what I said there.`, h.session)}">${icon('campus', 14)} How to explain it better</a></div>
    </div>`)}</div>` : html`<p class="muted small" style="padding:0 20px 18px">Every part went well so far.</p>`}</section>`;
}

function namedCard(d) {
  return html`<section class="card flush"><div class="card-head"><h2>Students who shared their name</h2><span class="chip">${d.students.length}</span></div>
    <p class="small muted" style="padding:0 20px 8px">Only from the lectures where they chose to show it. Everyone else stays anonymous.</p>
    <div class="list">${d.students.map((s) => html`<div class="term-row">
      <div class="spread"><strong>${s.name}</strong>${chip(s.status)}</div>
      <p class="small muted mt-4">${pct(s.understood)} understood · shared in ${plural(s.lectures, 'lecture')}</p>
      ${s.parts.length ? html`<ul class="small term-parts">${s.parts.slice(-5).map((p) => html`<li><a href="${reviewHref(p.session, p.part)}">${shortDate(p.date)} · ${p.part}</a> ${p.title}</li>`)}</ul>` : ''}
      <div class="cluster mt-8">${s.email ? html`<a class="btn btn-sm" href="mailto:${s.email}?subject=${encodeURIComponent(`${d.course.code}: the parts to go over`)}">${icon('message', 14)} Email</a>` : ''}
        <a class="btn btn-sm btn-ghost" href="${askHref(d.course.id, `Write short personal notes for ${s.name} in ${d.course.code}: what they found hard this term and how to work through it.`)}">${icon('campus', 14)} Notes for ${s.name.split(' ')[0]}</a></div>
    </div>`)}</div></section>`;
}

function lecturesCard(d) {
  return html`<section class="card flush"><div class="card-head"><h2>Every lecture</h2></div>
    <div class="list">${[...d.lectures].reverse().map((l) => html`<a class="list-row" href="${reviewHref(l.session)}">
      <span class="tile">${icon('presentation', 18)}</span>
      <span class="body"><span class="title">${l.title}</span><span class="sub">${shortDate(l.date)} · ${pct(l.understood)} understood · ${l.answeredBy} answered${l.flags ? ` · ${plural(l.flags, 'flag')}` : ''}${l.topic ? ` · ${l.topic.path}` : ''}</span></span>
      <span class="trail">${chip(l.status)}${icon('chevron-right', 16)}</span></a>`)}</div></section>`;
}

// ---- student

/** What a quiz on these parts should cover: their titles, the key points taught there and what the student asked. */
function quizFor(d, parts) {
  return {
    course_id: d.course.id,
    topic: `What I found hard in ${d.course.code}: ${parts.map((p) => p.title).join('; ')}`.slice(0, 200),
    notes: parts.map((p) => [`${p.lecture} (${shortDate(p.date)}), part ${p.part}: ${p.title}`, ...p.points.slice(0, 6).map((k) => `- ${k}`), ...p.flags.filter((f) => f.note).map((f) => `- I asked: ${f.note}`)].join('\n')).join('\n\n').slice(0, 19000),
    count: Math.min(15, Math.max(5, parts.length * 2)),
    difficulty: 'mixed',
  };
}

function mineView(d) {
  const a = d.averages;
  const name = assistantName();
  const tile = (value, label, tone = '') => html`<div class="review-stat ${tone}"><span class="review-big">${value}</span><span class="small muted">${label}</span></div>`;
  return html`
    ${pageHead({
      back: { href: `/courses/${d.course.id}`, label: d.course.code },
      title: 'My progress',
      subtitle: html`${d.course.title} · only you see this`,
      actions: html`${d.parts.length ? html`<button class="btn btn-primary" data-quiz-all>${icon('graduation', 17)} Quiz me on all of these</button>` : ''}
        <a class="btn" href="${askHref(d.course.id, `How am I doing in ${d.course.code}, and what should I work on first?`)}">${icon('campus', 17)} Ask ${name}</a>
        <a class="btn btn-ghost" href="/api/courses/${d.course.id}/progress.txt" download>${icon('download', 17)} For AI (.txt)</a>`,
    })}
    ${!a.lectures ? html`<div class="card">${empty({ icon: 'trending', title: 'Nothing yet', body: 'After your first live lecture in this course, your results and the parts to work on collect here.' })}</div>` : html`
    <div class="stack stagger">
      <section class="review-stats">
        ${tile(pct(a.you), 'You understood, on average', a.status === 'quiet' ? '' : `is-${a.status}`)}
        ${tile(a.parts, a.parts === 1 ? 'Part to work on' : 'Parts to work on', a.parts ? 'is-trouble' : 'is-good')}
        ${trendTile(d.trend)}
      </section>
      <section class="card review-chart-card"><div class="spread"><h2>How you followed, lecture by lecture</h2><span class="small muted">Tap a lecture for your recap</span></div>
        <div class="lecture-chart-wrap">${termChart(d.lectures, { you: true })}</div>
        <div class="chart-legend"><span><i style="background:${COLORS.following}"></i>Following</span><span><i style="background:${COLORS.unsure}"></i>Some unsure</span><span><i style="background:${COLORS.lost}"></i>Often lost</span></div>
      </section>
      <section class="card flush"><div class="card-head"><h2>Areas to work on</h2><span class="chip ${d.parts.length ? 'danger' : 'success'}">${d.parts.length}</span></div>
        ${d.parts.length ? html`<p class="small muted" style="padding:0 20px 8px">Every part you were unsure about, lost in or flagged, newest first.</p>
        <div class="list">${d.parts.map((p, i) => {
          const you = p.you ? YOU[p.you] : null;
          return html`<div class="term-row">
            <div class="spread"><span class="small muted">${shortDate(p.date)} · ${p.lecture}</span>${you ? html`<span class="chip ${you[0]}">${you[1]}</span>` : html`<span class="chip">${icon('flag', 13)} You flagged it</span>`}</div>
            <p class="mt-4"><strong>${p.part} · ${p.at}</strong> ${p.title}</p>
            <p class="small muted mt-4">${p.topic}</p>
            ${p.points.length > 1 ? html`<ul class="small term-parts">${p.points.slice(1, 5).map((k) => html`<li>${k}</li>`)}</ul>` : ''}
            ${p.flags.filter((f) => f.note).map((f) => html`<p class="small mt-4">${icon('flag', 13)} You asked: “${f.note}”</p>`)}
            <div class="cluster mt-8"><button class="btn btn-sm" data-quiz-one="${i}">${icon('graduation', 14)} Quiz me on this</button>
              <a class="btn btn-sm btn-ghost" href="${askHref(d.course.id, `Explain ${p.part} (${p.at}, “${p.title}”) of the lecture “${p.lecture}” to me simply, with one worked example and one question to check myself.`, p.session)}">${icon('sparkle', 14)} Explain it to me</a>
              <a class="btn btn-sm btn-ghost" href="${reviewHref(p.session, p.part)}">${icon('eye', 14)} My recap</a></div>
          </div>`;
        })}</div>` : html`<p class="muted small" style="padding:0 20px 18px">Nothing you found hard so far. Keep answering during lectures so this stays accurate.</p>`}
      </section>
      <section class="card flush"><div class="card-head"><h2>Every lecture</h2></div>
        <div class="list">${[...d.lectures].reverse().map((l) => html`<a class="list-row" href="${reviewHref(l.session)}">
          <span class="tile">${icon('presentation', 18)}</span>
          <span class="body"><span class="title">${l.title}</span><span class="sub">${shortDate(l.date)} · you ${pct(l.answered ? l.you : null)}${l.targets ? ` · ${plural(l.targets, 'part')} to work on` : ''}</span></span>
          <span class="trail">${icon('chevron-right', 16)}</span></a>`)}</div></section>
    </div>`}`;
}

export default {
  title: (d) => (d.view === 'term' ? `${d.course.code} · Term overview` : `${d.course.code} · My progress`),
  load: (ctx) => api.get(`/courses/${ctx.params.id}/progress`),
  render: (d) => (d.view === 'term' ? termView(d) : mineView(d)),
  mount(root, d, ctx) {
    // The bars of the chart open that lecture's review (SVG links do not go through the app's router).
    const go = on(root, 'click', '[data-go]', (e, g) => ctx.navigate(g.dataset.go));
    const key = on(root, 'keydown', '[data-go]', (e, g) => e.key === 'Enter' && ctx.navigate(g.dataset.go));
    if (d.view !== 'mine') return () => { go(); key(); };
    const quiz = (b, parts) => busy(b, async () => {
      try {
        toast(`${assistantName()} is writing your quiz…`, 'info', { duration: 2500 });
        const r = await api.post('/quizzes', quizFor(d, parts));
        ctx.navigate(`/quiz/${r.quiz.id}`);
      } catch (error) {
        toastError(error);
      }
    });
    const offs = [
      on(root, 'click', '[data-quiz-all]', (e, b) => quiz(b, d.parts.slice(0, 12))),
      on(root, 'click', '[data-quiz-one]', (e, b) => quiz(b, [d.parts[Number(b.dataset.quizOne)]])),
    ];
    return () => [go, key, ...offs].forEach((off) => off());
  },
};

export { termChart, quizFor };
