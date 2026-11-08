/** Practice-set player: one question at a time with instant feedback. */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { pageHead } from '../core/components.js';
import { toastError, confirm } from '../core/ui.js';

const LETTERS = 'ABCDE';

function question(pack, i, answers) {
  const q = pack.questions[i];
  const answered = answers[i] !== undefined;
  return html`<section class="card quiz-card">
    <div class="spread"><span class="chip">${i + 1} / ${pack.questions.length}</span>${pack.source === 'ai' ? html`<span class="chip outline">AI-written</span>` : ''}</div>
    <div class="bar mt-16"><span class="fill" style="width:${(100 * i) / pack.questions.length}%"></span></div>
    <h2 class="quiz-question">${q.question}</h2>
    <div class="choices">${q.options.map((o, j) => {
      const cls = !answered ? '' : j === q.answer ? 'is-correct' : j === answers[i] ? 'is-wrong' : '';
      return html`<button class="choice ${cls}" data-pick="${j}" ${answered ? 'disabled' : ''}><span class="letter">${LETTERS[j]}</span>${o}</button>`;
    })}</div>
    ${answered ? html`<div class="notice ${answers[i] === q.answer ? 'accent' : 'warning'} mt-16">${icon(answers[i] === q.answer ? 'check-circle' : 'info', 18)}<span>${answers[i] === q.answer ? 'Correct.' : `The answer is ${LETTERS[q.answer]}.`} ${q.explanation || ''}</span></div>
      <button class="btn btn-primary btn-lg btn-block mt-16" data-next>${i + 1 < pack.questions.length ? 'Next question' : 'See results'}</button>` : ''}
  </section>`;
}

function results(pack, score) {
  const total = pack.questions.length;
  const pct = Math.round((100 * score) / total);
  return html`<section class="card center" style="padding:36px 24px">
    <div class="score-ring" style="--p:${pct}"><span>${score}<small>/${total}</small></span></div>
    <h2 class="mt-16">${pct === 100 ? 'Perfect run' : pct >= 70 ? 'Nicely done' : 'Good practice'}</h2>
    <p class="muted mt-8">${score < total ? 'Questions you missed were added to your review queue.' : 'Everything right — come back in a few days to lock it in.'}</p>
    <div class="cluster mt-24" style="justify-content:center"><a class="btn" href="/learning/packs">All practice sets</a><a class="btn btn-primary" href="/learning">Go to review</a></div>
  </section>`;
}

export default {
  title: (d) => d.pack.title,
  roles: ['student'],
  async load(ctx) {
    return api.get(`/revision/${ctx.params.id}`);
  },
  render({ pack }) {
    return html`${pageHead({ back: { href: '/learning/packs', label: 'Practice' }, title: pack.title, actions: html`<button class="btn btn-ghost btn-icon" data-delete aria-label="Delete set">${icon('trash', 18)}</button>` })}
      <div id="quiz" class="quiz">${question(pack, 0, [])}</div>`;
  },
  mount(root, { pack }, ctx) {
    const answers = [];
    let i = 0;
    const stage = $('#quiz', root);
    const offs = [
      on(root, 'click', '[data-pick]', (e, b) => {
        answers[i] = Number(b.dataset.pick);
        render(stage, question(pack, i, answers));
      }),
      on(root, 'click', '[data-next]', async () => {
        i += 1;
        if (i < pack.questions.length) {
          render(stage, question(pack, i, answers));
          return;
        }
        try {
          const r = await api.post(`/revision/${pack.id}/result`, { answers });
          render(stage, results(pack, r.score));
        } catch (error) {
          toastError(error);
        }
      }),
      on(root, 'click', '[data-delete]', async () => {
        if (!(await confirm({ title: 'Delete this practice set?', message: 'Your review queue keeps any questions you missed.', confirmLabel: 'Delete', danger: true }))) return;
        await api.del(`/revision/${pack.id}`);
        ctx.navigate('/learning/packs');
      }),
    ];
    return () => offs.forEach((off) => off());
  },
};
