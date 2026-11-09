/**
 * Course page. Students rate topics and answer concept checks; lecturers see
 * live aggregate understanding and publish new checks. Updates arrive live.
 */
import { html, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session } from '../core/store.js';
import { pageHead, empty } from '../core/components.js';
import { shortDate, plural } from '../core/format.js';
import { sheet, onSubmit, toast, toastError, confirm, menu, busy } from '../core/ui.js';
import { debounce } from '../core/live.js';

const LEVELS = [[1, 'Lost'], [2, 'Getting there'], [3, 'Got it']];
const LETTERS = 'ABCDE';

function understanding(t) {
  const total = t.counts[1] + t.counts[2] + t.counts[3];
  const pct = (n) => (total ? (100 * n) / total : 0);
  return html`<div class="understanding">
    <div class="bar"><span class="lost" style="width:${pct(t.counts[1])}%"></span><span class="partial" style="width:${pct(t.counts[2])}%"></span><span class="got" style="width:${pct(t.counts[3])}%"></span></div>
    <div class="legend"><span><span class="dot" style="color:var(--danger)"></span>${t.counts[1]} lost</span><span><span class="dot" style="color:var(--warning)"></span>${t.counts[2]} getting there</span><span><span class="dot" style="color:var(--success)"></span>${t.counts[3]} got it</span><span class="faint">${plural(total, 'response')}</span></div>
  </div>`;
}

function rating(t) {
  return html`<div class="segmented rating" role="group" aria-label="How well did you understand ${t.title}?">
    ${LEVELS.map(([level, label]) => html`<button class="${t.myLevel === level ? 'is-active' : ''}" data-rate="${t.id}" data-level="${level}" aria-pressed="${t.myLevel === level}">${label}</button>`)}
  </div>`;
}

function poll(p, teacher) {
  if (teacher) {
    const max = Math.max(1, ...p.distribution);
    return html`<div class="check">
      <div class="spread"><strong>${p.question}</strong><span class="chip">${p.total ? `${Math.round((100 * p.correctCount) / p.total)}% correct` : 'No answers yet'}</span></div>
      <div class="check-results">${p.options.map((o, i) => html`<div class="check-result ${i === p.correct ? 'is-correct' : ''}"><span class="letter">${LETTERS[i]}</span><span class="grow truncate">${o}</span><span class="bar" style="width:38%"><span class="fill" style="width:${(100 * p.distribution[i]) / max}%;${i === p.correct ? 'background:var(--success)' : ''}"></span></span><b>${p.distribution[i]}</b></div>`)}</div>
    </div>`;
  }
  const answered = p.myAnswer !== null;
  return html`<div class="check">
    <strong>${p.question}</strong>
    <div class="choices mt-8">${p.options.map((o, i) => {
      const cls = !answered ? '' : i === p.correct ? 'is-correct' : i === p.myAnswer ? 'is-wrong' : '';
      return html`<button class="choice ${cls}" ${answered ? 'disabled' : ''} data-answer="${p.id}" data-choice="${i}"><span class="letter">${LETTERS[i]}</span>${o}${answered && i === p.correct ? html`<span style="margin-left:auto;color:var(--success)">${icon('check', 18)}</span>` : ''}</button>`;
    })}</div>
    ${answered ? html`<p class="small muted mt-8">${p.myAnswer === p.correct ? 'Correct.' : 'Not quite — this one is now in your review queue.'} ${p.total > 1 ? `${Math.round((100 * p.correctCount) / p.total)}% of the class got it right.` : ''}</p>` : ''}
  </div>`;
}

function topicView(t, teacher) {
  return html`<div class="topic" id="topic-${t.id}">
    <div class="spread"><h3>${t.title}</h3>${teacher ? html`<button class="btn btn-sm btn-ghost" data-add-check="${t.id}">${icon('plus', 15)} Concept check</button>` : ''}</div>
    ${teacher ? understanding(t) : rating(t)}
    ${t.polls.map((p) => poll(p, teacher))}
  </div>`;
}

function lectureView(l, teacher) {
  return html`<section class="card lecture">
    <div class="card-head">
      <div><h2>${l.topic}</h2><p class="small muted">${shortDate(l.created)} · ${plural(l.topics.length, 'topic')}</p></div>
      <div class="cluster">${l.status === 'active' ? html`<span class="chip success"><span class="dot live"></span>Active</span>` : html`<span class="chip">Ended</span>`}
        ${teacher ? html`<button class="btn btn-sm btn-ghost btn-icon" data-lecture-menu="${l.id}" data-status="${l.status}" aria-label="Lecture options">${icon('more', 18)}</button>` : ''}</div>
    </div>
    ${l.topics.length ? html`<div class="topics">${l.topics.map((t) => topicView(t, teacher))}</div>` : html`<p class="muted small">${teacher ? 'Add the topics you’ll cover so students can tell you how it’s going.' : 'Topics appear here as your lecturer adds them.'}</p>`}
    ${teacher ? html`<form class="input-row mt-16" data-add-topic="${l.id}"><input class="input" name="title" placeholder="Add a topic, e.g. Binary search" required minlength="3"><button class="btn">${icon('plus', 16)} Add</button></form>` : ''}
  </section>`;
}

export default {
  title: (d) => d.course.code,
  async load(ctx) {
    return api.get(`/courses/${ctx.params.id}`);
  },
  render(data) {
    const { course, lectures, isTeacher } = data;
    const student = session.user.role === 'student';
    return html`
      ${pageHead({
        back: { href: '/courses', label: student ? 'Courses' : 'Teaching' },
        title: course.title,
        subtitle: html`<span class="chip accent">${course.code}</span> &nbsp;${course.lecturer || 'Lecturer to be announced'} · ${plural(course.enrolled, 'student')}`,
        actions: html`
          <a class="btn" href="/schedule?course=${course.id}">${icon('calendar', 17)} Schedule</a>
          ${isTeacher ? html`<a class="btn btn-primary" href="/live/${course.id}">${icon('presentation', 17)} Live lecture</a><button class="btn" data-new-lecture>${icon('plus', 17)} New lecture</button>` : ''}
          ${student ? html`<button class="btn btn-primary" data-practice>${icon('graduation', 17)} Practice</button><button class="btn btn-ghost btn-icon" data-course-menu aria-label="More">${icon('more', 19)}</button>` : ''}`,
      })}
      ${student ? html`<div class="notice" style="margin-bottom:20px">${icon('lock', 18)}<span>Your ratings are private. Your lecturer only sees totals for the whole class.</span></div>` : ''}
      <div class="stack stagger">
        ${lectures.length ? lectures.map((l) => lectureView(l, isTeacher)) : html`<div class="card">${empty({ icon: 'presentation', title: 'No lectures yet', body: isTeacher ? 'Create a lecture, then add topics as you go.' : 'Your lecturer hasn’t published anything yet.', action: isTeacher ? html`<button class="btn btn-primary" data-new-lecture>Create first lecture</button>` : '' })}</div>`}
      </div>`;
  },
  mount(root, data, ctx) {
    const id = data.course.id;
    const offs = [
      on(root, 'click', '[data-rate]', async (e, b) => {
        b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('is-active', x === b));
        try {
          await api.post(`/topics/${b.dataset.rate}/respond`, { level: Number(b.dataset.level) });
        } catch (error) {
          toastError(error);
          ctx.refresh();
        }
      }),
      on(root, 'click', '[data-answer]', async (e, b) => {
        try {
          const r = await api.post(`/polls/${b.dataset.answer}/answer`, { answer: Number(b.dataset.choice) });
          toast(r.correct ? 'Correct' : 'Not quite — added to your review queue', r.correct ? 'success' : 'info');
          ctx.refresh();
        } catch (error) {
          toastError(error);
        }
      }),
      on(root, 'submit', '[data-add-topic]', async (e, form) => {
        e.preventDefault();
        await busy(form.querySelector('button'), async () => {
          try {
            await api.post(`/lectures/${form.dataset.addTopic}/topics`, { title: form.title.value });
            ctx.refresh();
          } catch (error) {
            toastError(error);
          }
        });
      }),
      on(root, 'click', '[data-new-lecture]', () => sheet({
        title: 'New lecture',
        content: html`<form class="form" id="lecture-form"><label class="field"><span>Title</span><input class="input" name="topic" required minlength="3" placeholder="Week 5 · Sorting algorithms" autofocus></label>
          <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Create</button></div></form>`,
        onMount(el, close) {
          onSubmit($('#lecture-form', el), async (v) => {
            await api.post(`/courses/${id}/lectures`, v);
            close();
            ctx.refresh();
          });
        },
      })),
      on(root, 'click', '[data-lecture-menu]', (e, b) => menu(b, [
        b.dataset.status === 'active'
          ? { label: 'End lecture', icon: 'check-circle', onSelect: () => api.patch(`/lectures/${b.dataset.lectureMenu}`, { status: 'ended' }).then(ctx.refresh, toastError) }
          : { label: 'Reopen lecture', icon: 'refresh', onSelect: () => api.patch(`/lectures/${b.dataset.lectureMenu}`, { status: 'active' }).then(ctx.refresh, toastError) },
      ])),
      on(root, 'click', '[data-add-check]', (e, b) => sheet({
        title: 'New concept check',
        content: html`<form class="form" id="check-form">
          <label class="field"><span>Question</span><textarea class="textarea" name="question" required minlength="10" placeholder="What is the time complexity of binary search?" autofocus></textarea></label>
          <div class="field"><span>Answers — select the correct one</span>
            ${[0, 1, 2, 3].map((i) => html`<div class="input-row" style="align-items:center"><input type="radio" name="correct" value="${i}" ${i === 0 ? 'checked' : ''} aria-label="Option ${LETTERS[i]} is correct" style="width:20px;height:20px;accent-color:var(--success);flex:none"><input class="input" name="o${i}" placeholder="Option ${LETTERS[i]}${i > 1 ? ' (optional)' : ''}" ${i < 2 ? 'required' : ''}></div>`)}
          </div>
          <p class="hint">Students enrolled in the course get a notification.</p>
          <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Publish</button></div>
        </form>`,
        onMount(el, close) {
          onSubmit($('#check-form', el), async (v) => {
            const options = [];
            let correct = 0;
            [0, 1, 2, 3].forEach((i) => {
              if (v[`o${i}`]?.trim()) {
                if (Number(v.correct) === i) correct = options.length;
                options.push(v[`o${i}`].trim());
              }
            });
            await api.post(`/topics/${b.dataset.addCheck}/polls`, { question: v.question, options, correct });
            close();
            ctx.refresh();
            return 'Concept check published';
          });
        },
      })),
      on(root, 'click', '[data-practice]', async (e, b) => busy(b, async () => {
        try {
          const r = await api.post('/revision', { course_id: id });
          if (r.warning) toast(r.warning, 'warning');
          ctx.navigate(`/learning/packs/${r.id}`);
        } catch (error) {
          toastError(error);
        }
      })),
      on(root, 'click', '[data-course-menu]', (e, b) => menu(b, [
        { label: 'Leave course', icon: 'logout', danger: true, onSelect: async () => {
          if (!(await confirm({ title: `Leave ${data.course.code}?`, message: 'Your ratings stay, but you’ll stop seeing this course.', confirmLabel: 'Leave', danger: true }))) return;
          await api.post(`/courses/${id}/leave`).catch(toastError);
          ctx.navigate('/courses');
        } },
      ])),
    ];
    ctx.live.on('course.updated', debounce((d) => d.courseId === id && ctx.refresh(), 600));
    return () => offs.forEach((off) => off());
  },
};
