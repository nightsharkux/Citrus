/** Career interest explorer: one question at a time, private results. */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session } from '../core/store.js';
import { pageHead } from '../core/components.js';
import { date } from '../core/format.js';
import { toastError, confirm } from '../core/ui.js';
import { printDocument } from '../features/print.js';

const LETTERS = 'ABCD';

function results(d) {
  const r = d.result;
  const max = Math.max(...Object.values(r.scores), 1);
  return html`<div class="stack stagger">
    <section class="hero">
      <p class="muted small">Your interest profile · ${date(d.updated)}</p>
      <h2 style="font-size:26px;margin-top:10px">You lean towards ${r.top.slice(0, 2).map((t) => t.label.toLowerCase()).join(' and ')}.</h2>
      <div class="cluster mt-16">${r.top.map((t) => html`<span class="chip">${t.label}</span>`)}</div>
    </section>
    <div class="grid-2">
      <section class="card"><h2>Directions to explore</h2>
        <div class="stack mt-16" style="--gap:14px">${r.recommendations.map((p, i) => html`<div class="cluster" style="align-items:flex-start;flex-wrap:nowrap"><span class="tile sm">${i + 1}</span><div><strong>${p.title}</strong><p class="small muted">${p.detail}</p></div></div>`)}</div>
      </section>
      <section class="card"><h2>Your signals</h2>
        <div class="stack mt-16" style="--gap:12px">${Object.entries(r.scores).sort((a, b) => b[1] - a[1]).map(([k, v]) => html`<div><div class="spread small"><span>${d.groups[k]}</span><b>${v}</b></div><div class="bar mt-8"><span class="fill" style="width:${(100 * v) / max}%"></span></div></div>`)}</div>
      </section>
    </div>
    <div class="notice">${icon('info', 18)}<span>${r.method} Results are visible only to you.</span></div>
    <div class="cluster">
      <a class="btn btn-primary" href="/assistant?q=${encodeURIComponent(`My career interests lean towards ${r.top.map((t) => t.label).join(', ')}. Which modules, projects or student jobs at my university could help me explore that?`)}">${icon('campus', 16)} Talk it through with Campus</a>
      <button class="btn" data-print>${icon('download', 16)} Save as PDF</button>
      <button class="btn" data-retake>Retake</button>
      <button class="btn btn-ghost" data-delete>Delete my answers</button>
    </div>
  </div>`;
}

function questionCard(d, i, answers) {
  const q = d.questions[i];
  return html`<section class="card quiz-card">
    <div class="spread"><span class="chip">${i + 1} of ${d.questions.length}</span>${i > 0 ? html`<button class="btn btn-sm btn-ghost" data-back>${icon('chevron-left', 15)} Back</button>` : ''}</div>
    <div class="bar mt-16"><span class="fill" style="width:${(100 * i) / d.questions.length}%"></span></div>
    <h2 class="quiz-question">${q.prompt}</h2>
    <div class="choices">${q.options.map((o, j) => html`<button class="choice ${answers[i] === j ? 'is-selected' : ''}" data-choose="${j}"><span class="letter">${LETTERS[j]}</span>${o}</button>`)}</div>
  </section>`;
}

export default {
  title: 'Career explorer',
  async load() {
    return api.get('/career');
  },
  render(d, ctx) {
    const retake = ctx.query.get('retake') === '1';
    return html`${pageHead({ title: 'Career explorer', subtitle: 'Eighteen everyday choices. No right answers — just a starting point for reflection.' })}
      <div id="career-stage">${d.result && !retake ? results(d) : html`<div class="stack">${questionCard(d, 0, d.answers || [])}<p class="small faint">Your answers are private and you can delete them any time.</p></div>`}</div>`;
  },
  mount(root, d, ctx) {
    const stage = $('#career-stage', root);
    const answers = [...(d.answers || [])];
    let i = 0;
    const offs = [
      on(root, 'click', '[data-choose]', async (e, b) => {
        answers[i] = Number(b.dataset.choose);
        b.classList.add('is-selected');
        if (i + 1 < d.questions.length) {
          i += 1;
          setTimeout(() => render(stage, html`<div class="stack">${questionCard(d, i, answers)}</div>`), 160);
          return;
        }
        try {
          await api.post('/career', { answers: answers.slice(0, d.questions.length) });
          ctx.navigate('/career', { replace: true });
        } catch (error) {
          toastError(error);
        }
      }),
      on(root, 'click', '[data-back]', () => {
        i = Math.max(0, i - 1);
        render(stage, html`<div class="stack">${questionCard(d, i, answers)}</div>`);
      }),
      on(root, 'click', '[data-retake]', () => ctx.navigate('/career?retake=1')),
      on(root, 'click', '[data-delete]', async () => {
        if (!(await confirm({ title: 'Delete your answers?', message: 'Your results are removed permanently.', confirmLabel: 'Delete', danger: true }))) return;
        await api.del('/career');
        ctx.refresh();
      }),
      on(root, 'click', '[data-print]', () => printDocument({
        title: 'Career interests',
        subtitle: `${session.user.name} · ${date(d.updated)} · Private exploratory report`,
        body: html`<p>${d.result.method}</p>
          <h2>Interest signals</h2><table>${Object.entries(d.result.scores).sort((a, b) => b[1] - a[1]).map(([k, v]) => html`<tr><td>${d.groups[k]}</td><td>${v}</td></tr>`)}</table>
          <h2>Directions to explore</h2><ol>${d.result.recommendations.map((p) => html`<li><strong>${p.title}</strong> — ${p.detail}</li>`)}</ol>
          <h2>Your answers</h2><ol>${d.questions.map((q, n) => html`<li>${q.prompt}<br><em>${q.options[d.answers[n]]}</em></li>`)}</ol>`,
      })),
    ];
    return () => offs.forEach((off) => off());
  },
};
