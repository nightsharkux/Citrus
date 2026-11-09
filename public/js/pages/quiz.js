/**
 * Quizzes: practise with questions written for you, like a tutor's (src/modules/quiz).
 *
 *   /quiz          make a quiz from a topic, one of your courses or your own notes; your earlier quizzes
 *   /quiz/new?…    make one straight away (what "quiz me" in the assistant opens)
 *   /quiz/:id      take it: one question at a time, eight kinds of question, a hint, a tutor for every
 *                  question, instant marking with an explanation, then results and a retry of the mistakes
 *
 * Keys: 1–6 pick an option, Enter checks or goes on.
 */
import { html, render, $, $$, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session, assistantName } from '../core/store.js';
import { pageHead, empty } from '../core/components.js';
import { markdown } from '../core/markdown.js';
import { ago } from '../core/format.js';
import { toast, toastError, confirm, sheet } from '../core/ui.js';
import { createFace } from '../features/face.js';
import { speak, stopSpeaking } from '../features/voice.js';

const LETTERS = 'ABCDEF';
const KIND_LABELS = { single: 'Multiple choice', multi: 'Select all that apply', truefalse: 'True or false', blank: 'Fill in the blank', short: 'Short answer', order: 'Put in order', match: 'Match', numeric: 'Calculation' };
const DIFFICULTY = [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], ['mixed', 'Mixed']];
const COUNTS = [5, 8, 12, 15];
const language = () => (document.documentElement.lang === 'de' ? 'de' : 'en');
const points = (n) => (Math.round(n * 10) / 10).toString();

// ------------------------------------------------------------------ making a quiz

function maker(courses, kinds) {
  return html`<section class="card quiz-maker">
    <h2>New quiz</h2>
    <form class="form mt-16" id="quiz-form">
      <div class="field"><span>Quiz me on</span><div class="cluster">${[['topic', 'A topic'], ['course', 'One of my courses'], ['notes', 'My notes']].map(([id, label], i) => html`<label class="chip-radio"><input type="radio" name="from" value="${id}" ${i === 0 ? 'checked' : ''} ${id === 'course' && !courses.length ? 'disabled' : ''}><span>${label}</span></label>`)}</div></div>
      <label class="field" data-from="topic"><input class="input" name="topic" maxlength="200" placeholder="Ohm’s law, SQL joins, the causes of the First World War…" aria-label="Topic"></label>
      <div class="input-row" data-from="course" hidden>
        <label class="field"><span>Course</span><select class="select" name="course_id">${courses.map((c) => html`<option value="${c.id}">${c.code} · ${c.title}</option>`)}</select></label>
        <label class="field"><span>Focus (optional)</span><input class="input" name="focus" maxlength="200" placeholder="A chapter or idea"></label>
      </div>
      <label class="field" data-from="notes" hidden><textarea class="textarea" name="notes" maxlength="20000" style="min-height:150px" placeholder="Paste lecture notes, a summary or any text you want to be tested on." aria-label="Your notes"></textarea></label>
      <div class="quiz-options">
        <div class="field"><span>Questions</span><div class="cluster">${COUNTS.map((n) => html`<label class="chip-radio"><input type="radio" name="count" value="${n}" ${n === 8 ? 'checked' : ''}><span>${n}</span></label>`)}</div></div>
        <div class="field"><span>Difficulty</span><div class="cluster">${DIFFICULTY.map(([id, label]) => html`<label class="chip-radio"><input type="radio" name="difficulty" value="${id}" ${id === 'mixed' ? 'checked' : ''}><span>${label}</span></label>`)}</div></div>
      </div>
      <div class="field"><span>Kinds of question</span><div class="cluster">${kinds.map((k) => html`<label class="chip-check"><input type="checkbox" name="types" value="${k.id}" checked><span>${KIND_LABELS[k.id] || k.label}</span></label>`)}</div></div>
      <div class="form-actions"><button class="btn btn-primary btn-lg">${icon('sparkle', 18)} Make my quiz</button></div>
    </form>
  </section>`;
}

function history(quizzes) {
  if (!quizzes.length) return empty({ icon: 'target', title: 'No quizzes yet', body: 'Your quizzes and scores will appear here. Questions you miss also come back in your review queue.' });
  return html`<div class="list">${quizzes.map((q) => {
    const pct = q.total ? Math.round((100 * q.score) / q.total) : 0;
    return html`<a class="list-row" href="/quiz/${q.id}">
      <span class="tile sm ${q.finished ? (pct >= 70 ? 'success' : 'warning') : ''}">${icon(q.finished ? 'check-circle' : 'target', 16)}</span>
      <span class="body"><span class="title">${q.title}</span><span class="sub">${q.total} questions · ${ago(q.created)}</span></span>
      <span class="trail">${q.finished ? html`<span class="chip">${pct}%</span>` : html`<span class="chip outline">${q.answered}/${q.total}</span>`}</span>
    </a>`;
  })}</div>`;
}

/** While the questions are written: the face thinks, and the steps it is taking go by. */
function writing() {
  return html`<section class="card quiz-writing center">
    <span data-writing-face></span>
    <h2 class="mt-16">Writing your questions</h2>
    <p class="muted mt-8" data-writing-step>Reading up on the topic</p>
  </section>`;
}

async function makeQuiz(body, stage, ctx) {
  render(stage, writing());
  const face = createFace({ size: 96, mood: 'thinking' });
  $('[data-writing-face]', stage)?.replaceWith(face.el);
  const steps = ['Reading up on the topic', 'Mixing the kinds of question', 'Writing hints and explanations', 'Checking the answers'];
  let step = 0;
  const timer = setInterval(() => {
    step = (step + 1) % steps.length;
    const el = $('[data-writing-step]', stage);
    if (el) el.textContent = steps[step];
  }, 2600);
  try {
    const made = await api.post('/quizzes', { ...body, language: language() });
    face.react('happy', 900);
    ctx.navigate(`/quiz/${made.quiz.id}`, { replace: true });
    return true;
  } catch (error) {
    face.setMood('idle').react('sad', 1600);
    render($('[data-writing-step]', stage), error.message);
    toastError(error);
    return false;
  } finally {
    clearInterval(timer);
  }
}

// ------------------------------------------------------------------ one question

const blanks = (text) => String(text).replace(/_{2,}/g, '……');

function input(q, i, a, draft) {
  const done = !!a;
  if (q.type === 'single' || q.type === 'multi' || q.type === 'truefalse') {
    const options = q.type === 'truefalse' ? ['True', 'False'] : q.options;
    const picked = done ? a.answer : draft;
    const isPicked = (j) => (q.type === 'multi' ? (picked || []).includes(j) : q.type === 'truefalse' ? picked === (j === 0) : picked === j);
    const isRight = (j) => (q.type === 'multi' ? a.key.includes(j) : q.type === 'truefalse' ? a.key === (j === 0) : a.key === j);
    return html`<div class="choices" role="${q.type === 'multi' ? 'group' : 'radiogroup'}">${options.map((o, j) => {
      const state = !done ? (isPicked(j) ? 'is-selected' : '') : isRight(j) ? 'is-correct' : isPicked(j) ? 'is-wrong' : '';
      return html`<button type="button" class="choice ${state}" data-opt="${j}" ${done ? 'disabled' : ''} aria-pressed="${isPicked(j)}">
        <span class="letter">${q.type === 'multi' ? (isPicked(j) ? icon('check', 13) : '') : LETTERS[j]}</span><span class="grow md">${markdown(o)}</span></button>`;
    })}</div>`;
  }
  if (q.type === 'blank') return html`<input class="input quiz-text" name="answer" autocomplete="off" maxlength="100" placeholder="Your answer" value="${done ? a.answer : draft || ''}" ${done ? 'disabled' : ''} aria-label="Your answer">`;
  if (q.type === 'short') return html`<textarea class="textarea quiz-text" name="answer" maxlength="3000" style="min-height:120px" placeholder="Answer in your own words. Ctrl+Enter checks it." ${done ? 'disabled' : ''} aria-label="Your answer">${done ? a.answer : draft || ''}</textarea>`;
  if (q.type === 'numeric') return html`<div class="quiz-number"><input class="input quiz-text" name="answer" inputmode="decimal" autocomplete="off" maxlength="40" placeholder="Your answer" value="${done ? a.answer : draft || ''}" ${done ? 'disabled' : ''} aria-label="Your answer">${q.unit ? html`<span class="quiz-unit">${q.unit}</span>` : ''}</div>`;
  if (q.type === 'order') {
    const items = done ? a.answer : draft;
    return html`<ol class="quiz-order">${items.map((item, k) => html`<li class="${done ? (a.key[k] === item ? 'is-correct' : 'is-wrong') : ''}">
      <span class="letter">${k + 1}</span><span class="grow md">${markdown(item)}</span>
      ${done ? '' : html`<span class="quiz-move"><button type="button" class="btn btn-ghost btn-icon btn-sm" data-move="-1" data-at="${k}" aria-label="Move up" ${k === 0 ? 'disabled' : ''}>${icon('arrow-up', 15)}</button><button type="button" class="btn btn-ghost btn-icon btn-sm quiz-down" data-move="1" data-at="${k}" aria-label="Move down" ${k === items.length - 1 ? 'disabled' : ''}>${icon('arrow-up', 15)}</button></span>`}
    </li>`)}</ol>`;
  }
  if (q.type === 'match') {
    const chosen = done ? a.answer : draft;
    return html`<div class="quiz-match">${q.left.map((term, k) => html`<label class="quiz-match-row ${done ? (a.key[k] === chosen[k] ? 'is-correct' : 'is-wrong') : ''}">
      <span class="md">${markdown(term)}</span>
      <select class="select" data-match="${k}" ${done ? 'disabled' : ''} aria-label="${term}"><option value="">Choose…</option>${q.right.map((r) => html`<option value="${r}" ${chosen[k] === r ? 'selected' : ''}>${r}</option>`)}</select>
    </label>`)}</div>`;
  }
  return '';
}

function feedback(q, a) {
  const tone = a.correct ? 'is-correct' : a.score > 0 ? 'is-partial' : 'is-wrong';
  const title = a.correct ? 'Correct' : a.score > 0 ? `Partly right · ${Math.round(a.score * 100)}%` : 'Not quite';
  return html`<div class="quiz-feedback ${tone}" role="status">
    <strong>${icon(a.correct ? 'check-circle' : a.score > 0 ? 'info' : 'alert', 18)} ${title}</strong>
    ${a.feedback ? html`<p>${a.feedback}</p>` : ''}
    ${a.correct && q.type !== 'short' ? '' : html`<p><b>${q.type === 'short' ? 'Model answer' : 'Answer'}:</b> <span class="md">${markdown(q.type === 'truefalse' ? (a.key ? 'True' : 'False') : a.solution)}</span></p>`}
    ${a.explanation ? html`<div class="prose small">${markdown(a.explanation)}</div>` : ''}
  </div>`;
}

function questionCard(quiz, q, i, a, view) {
  const last = i === quiz.total - 1;
  return html`<section class="card quiz-card" data-q="${i}">
    <div class="spread"><span class="chip">${i + 1} / ${quiz.total}</span><span class="chip outline">${KIND_LABELS[q.type] || q.label}</span></div>
    <div class="quiz-question prose">${markdown(blanks(q.question))}</div>
    <div class="quiz-input">${input(q, i, a, view.draft)}</div>
    ${a ? feedback(q, a) : view.hint ? html`<div class="notice accent">${icon('bulb', 18)}<span>${q.hint}</span></div>` : ''}
    <div class="quiz-actions">
      ${!a && q.hint && !view.hint ? html`<button type="button" class="btn btn-ghost" data-hint>${icon('bulb', 16)} Hint</button>` : ''}
      <button type="button" class="btn btn-ghost" data-tutor>${icon('message', 16)} Ask the tutor</button>
      <button type="button" class="btn btn-ghost btn-icon" data-read aria-label="Read the question aloud" title="Read aloud">${icon('volume', 16)}</button>
      <span class="grow"></span>
      ${a ? html`<button type="button" class="btn btn-primary" data-next>${last ? 'See results' : 'Next question'} ${icon('arrow-right', 16)}</button>`
        : html`<button type="button" class="btn btn-primary" data-check ${view.busy ? 'disabled' : ''}>${view.busy ? 'Checking…' : 'Check'}</button>`}
    </div>
  </section>`;
}

function results(data) {
  const { quiz, questions, answers } = data;
  const pct = quiz.total ? Math.round((100 * quiz.score) / quiz.total) : 0;
  const missed = questions.filter((_, i) => !answers[i]?.correct).length;
  return html`<section class="card quiz-results center">
    <div class="score-ring" style="--p:${pct}"><span>${pct}<small>%</small></span></div>
    <h2 class="mt-16">${pct === 100 ? 'Perfect score' : pct >= 80 ? 'Excellent work' : pct >= 60 ? 'Good going' : 'Good practice'}</h2>
    <p class="muted mt-8">${points(quiz.score)} of ${quiz.total} points.${missed && session.user.role === 'student' ? ' The questions you missed are in your review queue too.' : ''}</p>
    <div class="cluster mt-24" style="justify-content:center">
      ${missed ? html`<button class="btn btn-primary" data-retry>${icon('refresh', 16)} Practise my ${missed === 1 ? 'mistake' : `${missed} mistakes`}</button>` : ''}
      <a class="btn" href="/quiz">${icon('plus', 16)} New quiz</a>
      <a class="btn btn-ghost" href="/assistant?new=1&q=${encodeURIComponent(`Help me understand ${quiz.topic} better. I just scored ${pct}% on a quiz about it.`)}">${icon('campus', 16)} Talk it through</a>
    </div>
  </section>
  <section class="card flush mt-16"><div class="card-head"><h3>Your answers</h3></div>
    <div class="list">${questions.map((q, i) => {
      const a = answers[i];
      return html`<button class="list-row" data-goto="${i}">
        <span class="tile sm ${a?.correct ? 'success' : a?.score > 0 ? 'warning' : 'danger'}">${icon(a?.correct ? 'check' : a?.score > 0 ? 'info' : 'x', 15)}</span>
        <span class="body"><span class="title">${q.question.replace(/[$*_`]/g, '').slice(0, 140)}</span><span class="sub">${KIND_LABELS[q.type]}${a && !a.correct ? ` · ${String(a.solution).slice(0, 90)}` : ''}</span></span>
      </button>`;
    })}</div>
  </section>`;
}

// ------------------------------------------------------------------ the tutor

function openTutor(data, index, conversations) {
  const q = data.questions[index];
  const answered = !!data.answers[index];
  const log = conversations.get(index) || [];
  conversations.set(index, log);
  const starters = answered ? ['Why is that the answer?', 'Explain the idea behind this', 'Give me a similar question'] : ['Give me a hint', 'Explain what the question asks', 'Where do I start?'];
  sheet({
    title: `Tutor · Question ${index + 1}`,
    wide: true,
    content: html`<div class="tutor">
      <div class="tutor-question small muted md">${markdown(blanks(q.question))}</div>
      <div class="tutor-log" data-log aria-live="polite"></div>
      <div class="cluster" data-starters>${starters.map((s) => html`<button type="button" class="suggestion" data-ask="${s}"><span>${s}</span></button>`)}</div>
      <form class="composer tutor-form"><textarea name="message" rows="1" maxlength="2000" placeholder="Ask about this question" aria-label="Ask the tutor"></textarea><div class="composer-actions"><button class="btn btn-primary btn-icon composer-send" aria-label="Send">${icon('arrow-up', 19)}</button></div></form>
    </div>`,
    onMount(el) {
      const box = $('[data-log]', el);
      const form = $('form', el);
      const draw = () => {
        render(box, html`${log.map((m) => html`<div class="tutor-msg ${m.role}">${m.role === 'assistant' ? html`<div class="prose">${markdown(m.content)}</div>` : m.content}</div>`)}`);
        box.scrollTop = box.scrollHeight;
      };
      draw();
      let busy = false;
      const ask = async (textValue) => {
        const message = textValue.trim();
        if (!message || busy) return;
        busy = true;
        log.push({ role: 'user', content: message });
        draw();
        box.insertAdjacentHTML('beforeend', '<div class="tutor-msg assistant"><span class="typing"><i></i><i></i><i></i></span></div>');
        box.scrollTop = box.scrollHeight;
        try {
          const r = await api.post(`/quizzes/${data.quiz.id}/tutor`, { index, messages: log.slice(-10) });
          log.push({ role: 'assistant', content: r.reply });
        } catch (error) {
          log.pop();
          toastError(error);
        } finally {
          busy = false;
          draw();
        }
      };
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        ask(form.message.value);
        form.message.value = '';
      });
      form.message.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
      on(el, 'click', '[data-ask]', (e, b) => ask(b.dataset.ask));
      if (matchMedia('(pointer: fine)').matches) form.message.focus();
    },
  });
}

// ------------------------------------------------------------------ the page

export default {
  title: (d) => (d?.mode === 'play' ? d.quiz.title : 'Quizzes'),
  async load(ctx) {
    const id = ctx.params.id;
    if (id && id !== 'new') return { mode: 'play', ...(await api.get(`/quizzes/${id}`)) };
    const [list, courses] = await Promise.all([api.get('/quizzes'), api.get('/courses').catch(() => ({ courses: [] }))]);
    const mine = (courses.courses || []).filter((c) => session.user.role !== 'student' || c.enrolled);
    return { mode: id === 'new' ? 'new' : 'home', ...list, courses: mine };
  },

  render(d) {
    if (d.mode === 'play') {
      return html`${pageHead({ back: { href: '/quiz', label: 'Quizzes' }, title: d.quiz.title, actions: html`<button class="btn btn-ghost btn-icon" data-delete aria-label="Delete quiz" title="Delete">${icon('trash', 18)}</button>` })}
        <div class="quiz">
          <div class="quiz-top"><span data-quiz-face></span><div class="quiz-progress" data-progress></div><span class="quiz-score" data-score></span></div>
          <div id="quiz-stage"></div>
        </div>`;
    }
    return html`${pageHead({ title: 'Quizzes', subtitle: `Practise with questions ${assistantName()} writes for you: eight kinds of question, instant feedback, and a tutor for every question.` })}
      <div class="quiz-home stagger">
        <div id="quiz-stage">${d.ai ? maker(d.courses, d.kinds) : html`<div class="notice warning">${icon('info', 18)}<span>Quizzes are written by the assistant, which is not connected yet.</span></div>`}</div>
        <section class="card flush"><div class="card-head"><h2>Your quizzes</h2></div>${history(d.quizzes)}</section>
      </div>`;
  },

  mount(root, d, ctx) {
    const stage = $('#quiz-stage', root);
    if (d.mode === 'home' || d.mode === 'new') return mountHome(root, d, ctx, stage);
    return mountPlay(root, d, ctx, stage);
  },
};

function mountHome(root, d, ctx, stage) {
  if (d.mode === 'new') {
    // From the assistant: make the quiz straight away with the settings it chose.
    const q = ctx.query;
    const body = { topic: q.get('topic') || '', count: Number(q.get('count')) || 6, difficulty: q.get('difficulty') || 'mixed', ...(q.get('types') ? { types: q.get('types').split(',') } : {}), ...(q.get('course') ? { course_id: Number(q.get('course')) } : {}) };
    makeQuiz(body, stage, ctx).then((ok) => {
      if (!ok) setTimeout(() => ctx.navigate('/quiz', { replace: true }), 2400);
    });
    return undefined;
  }
  const form = $('#quiz-form', root);
  if (!form) return undefined;
  const from = () => form.querySelector('input[name="from"]:checked').value;
  const offs = [
    on(form, 'change', 'input[name="from"]', () => {
      $$('[data-from]', form).forEach((el) => { el.hidden = el.dataset.from !== from(); });
    }),
  ];
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const types = $$('input[name="types"]:checked', form).map((i) => i.value);
    if (!types.length) return toast('Choose at least one kind of question.', 'error');
    const body = {
      count: Number(form.querySelector('input[name="count"]:checked').value),
      difficulty: form.querySelector('input[name="difficulty"]:checked').value,
      types,
    };
    if (from() === 'topic') body.topic = form.topic.value.trim();
    if (from() === 'course') Object.assign(body, { course_id: Number(form.course_id.value), topic: form.focus.value.trim() });
    if (from() === 'notes') body.notes = form.notes.value.trim();
    if (!body.topic && !body.notes && !body.course_id) {
      toast(from() === 'notes' ? 'Paste the notes you want to be quizzed on.' : 'What should the quiz be about?', 'error');
      return;
    }
    const before = stage.innerHTML;
    const ok = await makeQuiz(body, stage, ctx);
    if (!ok) setTimeout(() => { if (stage.isConnected) stage.innerHTML = before; }, 2400);
  });
  return () => offs.forEach((off) => off());
}

function mountPlay(root, data, ctx, stage) {
  const { quiz, questions } = data;
  const answers = data.answers;
  const conversations = new Map();
  const face = createFace({ size: 44, mood: 'idle' });
  $('[data-quiz-face]', root).replaceWith(face.el);
  let streak = 0;
  let index = questions.findIndex((_, i) => !answers[i]);
  let showingResults = index < 0;
  if (index < 0) index = 0;
  const view = { draft: null, hint: false, busy: false };
  const freshDraft = (q) => (q.type === 'order' ? [...q.items] : q.type === 'match' ? q.left.map(() => '') : q.type === 'multi' ? [] : null);

  function paintTop() {
    render($('[data-progress]', root), html`${questions.map((_, i) => {
      const a = answers[i];
      const tone = a ? (a.correct ? 'is-correct' : a.score > 0 ? 'is-partial' : 'is-wrong') : '';
      return html`<button class="quiz-dot ${tone} ${i === index && !showingResults ? 'is-current' : ''}" data-goto="${i}" aria-label="Question ${i + 1}"></button>`;
    })}`);
    $('[data-score]', root).textContent = `${points(quiz.score)} / ${quiz.total}`;
  }

  function paint({ focus = false } = {}) {
    paintTop();
    if (showingResults) {
      render(stage, results({ quiz, questions, answers }));
      return;
    }
    const q = questions[index];
    if (view.draft === null && !answers[index]) view.draft = freshDraft(q);
    render(stage, questionCard(quiz, q, index, answers[index], view));
    if (focus && matchMedia('(pointer: fine)').matches) $('.quiz-text', stage)?.focus();
  }

  function go(i) {
    stopSpeaking();
    index = Math.max(0, Math.min(questions.length - 1, i));
    showingResults = false;
    view.draft = null;
    view.hint = false;
    paint({ focus: true });
    stage.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** The answer in the shape the server marks. Null when nothing was given yet. */
  function currentAnswer() {
    const q = questions[index];
    const typed = $('.quiz-text', stage)?.value?.trim();
    switch (q.type) {
      case 'single': return Number.isInteger(view.draft) ? view.draft : null;
      case 'truefalse': return typeof view.draft === 'boolean' ? view.draft : null;
      case 'multi': return view.draft?.length ? view.draft : null;
      case 'order': return view.draft;
      case 'match': return view.draft.every(Boolean) ? view.draft : null;
      default: return typed || null;
    }
  }

  async function check() {
    if (view.busy || answers[index]) return;
    const answer = currentAnswer();
    if (answer === null) {
      toast(questions[index].type === 'match' ? 'Match every term first.' : 'Answer the question first.', 'info');
      return;
    }
    view.busy = true;
    paint();
    try {
      const r = await api.post(`/quizzes/${quiz.id}/answers`, { index, answer });
      answers[index] = r;
      Object.assign(quiz, r.quiz);
      streak = r.correct ? streak + 1 : 0;
      if (r.correct) face.react(streak >= 3 ? 'excited' : 'happy', streak >= 3 ? 1800 : 1200);
      else face.react(r.score > 0 ? 'curious' : 'sad', 1300);
    } catch (error) {
      toastError(error);
    } finally {
      view.busy = false;
      paint();
      $('[data-next]', stage)?.focus({ preventScroll: true });
    }
  }

  function next() {
    stopSpeaking();
    const open = questions.findIndex((_, i) => i > index && !answers[i]);
    const any = questions.findIndex((_, i) => !answers[i]);
    if (open >= 0) go(open);
    else if (any >= 0) go(any);
    else {
      showingResults = true;
      face.react(quiz.score / quiz.total >= 0.8 ? 'excited' : 'happy', 2000);
      paint();
      stage.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  function readAloud() {
    const q = questions[index];
    const options = q.type === 'single' || q.type === 'multi' ? q.options.map((o, j) => `${LETTERS[j]}: ${o}.`).join(' ') : q.type === 'truefalse' ? 'True or false?' : q.type === 'order' ? `Put in order: ${(answers[index]?.answer || view.draft || q.items).join('; ')}.` : q.type === 'match' ? `Match: ${q.left.join('; ')}. With: ${q.right.join('; ')}.` : '';
    face.setMood('speaking');
    speak(`${blanks(q.question).replace(/……/g, 'blank')} ${options}`, { onEnd: () => face.setMood('idle') });
  }

  const offs = [
    on(stage, 'click', '[data-opt]', (e, b) => {
      const q = questions[index];
      const j = Number(b.dataset.opt);
      if (q.type === 'multi') view.draft = view.draft.includes(j) ? view.draft.filter((x) => x !== j) : [...view.draft, j].sort((x, y) => x - y);
      else view.draft = q.type === 'truefalse' ? j === 0 : j;
      paint();
    }),
    on(stage, 'click', '[data-move]', (e, b) => {
      const k = Number(b.dataset.at);
      const to = k + Number(b.dataset.move);
      const items = view.draft;
      [items[k], items[to]] = [items[to], items[k]];
      paint();
      $(`[data-move][data-at="${to}"]`, stage)?.focus();
    }),
    on(stage, 'change', '[data-match]', (e, s) => {
      view.draft[Number(s.dataset.match)] = s.value;
    }),
    on(stage, 'input', '.quiz-text', (e) => {
      view.draft = e.target.value;
    }),
    on(stage, 'click', '[data-check]', () => check()),
    on(stage, 'click', '[data-next]', () => next()),
    on(stage, 'click', '[data-hint]', () => {
      view.hint = true;
      face.react('curious', 900);
      paint();
    }),
    on(stage, 'click', '[data-tutor]', () => openTutor({ quiz, questions, answers }, index, conversations)),
    on(stage, 'click', '[data-read]', () => readAloud()),
    on(root, 'click', '[data-goto]', (e, b) => go(Number(b.dataset.goto))),
    on(stage, 'click', '[data-retry]', async (e, b) => {
      b.disabled = true;
      try {
        const r = await api.post(`/quizzes/${quiz.id}/retry`);
        ctx.navigate(`/quiz/${r.quiz.id}`);
      } catch (error) {
        b.disabled = false;
        toastError(error);
      }
    }),
    on(root, 'click', '[data-delete]', async () => {
      if (!(await confirm({ title: 'Delete this quiz?', message: 'Questions you missed stay in your review queue.', confirmLabel: 'Delete', danger: true }))) return;
      await api.del(`/quizzes/${quiz.id}`).catch(toastError);
      ctx.navigate('/quiz');
    }),
  ];

  // 1–6 pick an option, Enter checks or moves on (Ctrl+Enter in a written answer).
  const onKey = (e) => {
    if (showingResults || document.querySelector('.sheet-backdrop') || e.metaKey || e.altKey) return;
    const q = questions[index];
    const inText = e.target.matches?.('input, textarea, select');
    if (!inText && /^[1-6]$/.test(e.key) && (q.type === 'single' || q.type === 'multi' || q.type === 'truefalse') && !answers[index]) {
      $(`[data-opt="${Number(e.key) - 1}"]`, stage)?.click();
    } else if (e.key === 'Enter' && !e.isComposing && (!inText || e.target.tagName === 'INPUT' || e.ctrlKey)) {
      if (e.target.closest?.('button, a') && !inText) return; // a focused button handles Enter itself
      e.preventDefault();
      if (answers[index]) next();
      else check();
    }
  };
  document.addEventListener('keydown', onKey);
  paint({ focus: true });

  return () => {
    offs.forEach((off) => off());
    document.removeEventListener('keydown', onKey);
    stopSpeaking();
    face.destroy();
  };
}
