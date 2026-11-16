/** Learning: spaced review, revision packs and progress. Students only. */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { pageHead, segmented, empty, row, courseTile } from '../core/components.js';
import { dayLabel, time, shortDate, plural } from '../core/format.js';
import { sheet, onSubmit, toast, toastError } from '../core/ui.js';

const TABS = [['review', 'Review', '/learning'], ['packs', 'Practice', '/learning/packs'], ['progress', 'Progress', '/learning/progress']];
const GRADE_LABEL = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };
const interval = (days) => (days === 0 ? '<10m' : days === 1 ? '1d' : days < 30 ? `${days}d` : `${Math.round(days / 30)}mo`);

export default {
  title: 'Learning',
  roles: ['student'],
  async load(ctx) {
    const tab = ctx.params.tab || 'review';
    if (tab === 'packs') return { tab, ...(await api.get('/revision')), courses: (await api.get('/courses')).courses.filter((c) => c.enrolled) };
    if (tab === 'progress') return { tab, ...(await api.get('/progress')) };
    return { tab: 'review', ...(await api.get('/review')) };
  },
  render(data) {
    return html`
      ${pageHead({ title: 'Learning', subtitle: 'Short, regular practice beats cramming. Your review queue fills itself from your ratings and answers.' })}
      <div class="page-tabs">${segmented(TABS, data.tab)}</div>
      <div class="stagger">${data.tab === 'packs' ? packs(data) : data.tab === 'progress' ? progress(data) : review(data)}</div>`;
  },
  mount(root, data, ctx) {
    if (data.tab === 'review') return mountReview(root, data, ctx);
    if (data.tab === 'packs') return mountPacks(root, data, ctx);
    return undefined;
  },
};

// ---------------------------------------------------------------- Review

function review({ due, stats }) {
  return html`
    <div class="stats">
      <div class="card stat"><div class="stat-value">${stats.dueNow}</div><div class="stat-label">Due now</div></div>
      <div class="card stat"><div class="stat-value">${stats.learning}</div><div class="stat-label">Learning</div></div>
      <div class="card stat"><div class="stat-value">${stats.mastered}</div><div class="stat-label">Long-term</div></div>
    </div>
    <div class="mt-24" id="review-stage">${due.length ? card(due[0], 0, due.length) : done(stats)}</div>`;
}

function card(item, index, total) {
  return html`<section class="card review-card" data-id="${item.id}">
    <div class="spread"><span class="chip">${item.course || 'General'} · ${item.kind === 'topic' ? 'Topic' : item.kind === 'poll' ? 'Concept check' : 'Practice'}</span><span class="small faint">${index + 1} of ${total}</span></div>
    <div class="review-prompt">${item.prompt}</div>
    <div class="review-answer hidden">${item.answer ? html`<p class="small faint">Answer</p><p>${item.answer}</p>` : html`<p class="muted">Compare your explanation with your notes or ask Citrus to check it.</p>`}</div>
    <div class="review-actions">
      <button class="btn btn-primary btn-lg btn-block" data-reveal>Show answer</button>
      <div class="grades hidden">${Object.entries(item.preview).map(([g, d]) => html`<button class="btn grade grade-${g}" data-grade="${g}"><b>${GRADE_LABEL[g]}</b><small>${interval(d)}</small></button>`)}</div>
    </div>
    <a class="small" href="/assistant?q=${encodeURIComponent(`Help me understand: ${item.prompt}`)}">${icon('campus', 14)} Ask Citrus about this</a>
  </section>`;
}

function done(stats) {
  return html`<section class="card">${empty({
    icon: 'check-circle',
    title: stats.total ? 'All caught up' : 'Nothing to review yet',
    body: stats.total ? `Next review ${stats.nextDue ? `${dayLabel(stats.nextDue).toLowerCase()} at ${time(stats.nextDue)}` : 'soon'}.` : 'Rate topics as “Lost” or “Getting there”, or miss a concept check, and they’ll appear here at the right time.',
    action: html`<a class="btn" href="/learning/packs">Try a practice set</a>`,
  })}</section>`;
}

function mountReview(root, data, ctx) {
  let index = 0;
  const stage = $('#review-stage', root);
  const off = on(root, 'click', '[data-reveal], [data-grade]', async (e, b) => {
    const el = b.closest('.review-card');
    if (b.dataset.reveal !== undefined) {
      el.querySelector('.review-answer').classList.remove('hidden');
      b.classList.add('hidden');
      el.querySelector('.grades').classList.remove('hidden');
      return;
    }
    el.classList.add('is-leaving');
    try {
      await api.post(`/review/${el.dataset.id}`, { grade: b.dataset.grade });
    } catch (error) {
      toastError(error);
    }
    index += 1;
    setTimeout(() => {
      if (index < data.due.length) render(stage, card(data.due[index], index, data.due.length));
      else ctx.refresh();
    }, 180);
  });
  const keys = (e) => {
    const visible = stage.querySelector('.review-card');
    if (!visible || e.target.closest('input, textarea')) return;
    if (e.key === ' ' && !visible.querySelector('[data-reveal]').classList.contains('hidden')) { e.preventDefault(); visible.querySelector('[data-reveal]').click(); }
    const g = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }[e.key];
    if (g && !visible.querySelector('.grades').classList.contains('hidden')) visible.querySelector(`[data-grade="${g}"]`).click();
  };
  document.addEventListener('keydown', keys);
  return () => {
    off();
    document.removeEventListener('keydown', keys);
  };
}

// ---------------------------------------------------------------- Practice packs

function packs({ packs: list, courses }) {
  return html`<section class="card flush">
    <div class="card-head"><h2>Practice sets</h2><button class="btn btn-primary btn-sm" data-new-pack ${courses.length ? '' : 'disabled'}>${icon('plus', 15)} New set</button></div>
    ${list.length ? html`<div class="list" style="padding-bottom:8px">${list.map((p) => row({
      href: `/learning/packs/${p.id}`,
      tile: courseTile(p.code || '•'),
      title: p.title,
      sub: `${plural(p.count, 'question')} · ${shortDate(p.created)}${p.source === 'ai' ? ' · AI-written' : ' · From your lecturer’s checks'}`,
      trail: p.best_score !== null ? html`<span class="chip ${p.best_score === p.count ? 'success' : ''}">Best ${p.best_score}/${p.count}</span>` : '',
    }))}</div>`
      : empty({ icon: 'graduation', title: 'No practice sets yet', body: courses.length ? 'Create one for any course. If your university has an AI model connected, questions are tailored to topics you found hard.' : 'Join a course first.' })}
  </section>
  <p class="small faint mt-16">AI-written questions can contain mistakes. If something looks wrong, check your course material.</p>`;
}

function mountPacks(root, data, ctx) {
  return on(root, 'click', '[data-new-pack]', () => sheet({
    title: 'New practice set',
    content: html`<form class="form" id="pack-form">
      <label class="field"><span>Course</span><select class="select" name="course_id">${data.courses.map((c) => html`<option value="${c.id}">${c.code} · ${c.title}</option>`)}</select></label>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Create</button></div>
    </form>`,
    onMount(el, close) {
      onSubmit($('#pack-form', el), async (v) => {
        const r = await api.post('/revision', { course_id: Number(v.course_id) });
        if (r.warning) toast(r.warning, 'warning');
        close();
        ctx.navigate(`/learning/packs/${r.id}`);
      });
    },
  }));
}

// ---------------------------------------------------------------- Progress

function progress({ courses }) {
  if (!courses.length) return html`<div class="card">${empty({ icon: 'trending', title: 'No courses yet', action: html`<a class="btn btn-primary" href="/courses">Browse courses</a>` })}</div>`;
  return html`<div class="grid-2">${courses.map((c) => {
    const rated = c.topics ? Math.round((100 * c.rated) / c.topics) : 0;
    const understood = c.rated ? Math.round((100 * c.understood) / c.rated) : 0;
    const accuracy = c.answered ? Math.round((100 * c.correct) / c.answered) : null;
    return html`<a class="card" href="/courses/${c.id}">
      <div class="cluster">${courseTile(c.code)}<div class="grow"><strong class="truncate" style="display:block">${c.title}</strong><span class="small muted">${c.code}</span></div></div>
      <div class="stack mt-16" style="--gap:12px">
        <div><div class="spread small"><span class="muted">Topics rated</span><b>${c.rated}/${c.topics}</b></div><div class="bar mt-8"><span class="fill" style="width:${rated}%"></span></div></div>
        <div><div class="spread small"><span class="muted">Marked “got it”</span><b>${understood}%</b></div><div class="bar mt-8"><span class="got" style="width:${understood}%"></span></div></div>
        <div class="spread small"><span class="muted">Concept checks</span><b>${accuracy === null ? '—' : `${c.correct}/${c.answered} correct`}</b></div>
      </div>
    </a>`;
  })}</div>
  <p class="small faint mt-16">These numbers reflect your own ratings and answers. They’re a guide for where to focus, not a grade.</p>`;
}
