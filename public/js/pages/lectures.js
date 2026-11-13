/**
 * Lectures: one list of what is happening, what is coming up (with date, time and room) and what happened lately,
 * across your courses. Students also see lectures of other courses at their university and join the course from
 * the row. Lecturers see their own and start or resume a live lecture from it.
 */
import { html, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session } from '../core/store.js';
import { pageHead, empty, courseTile } from '../core/components.js';
import { dayLabel, dayKey, time, shortDate } from '../core/format.js';
import { toast, toastError, busy } from '../core/ui.js';
import { joinForm, mountJoinForm } from './live.js';

const isLecturer = () => session.user.role !== 'student';

/** "Today · 10:00–11:30 · HSG 001", "Wed 12 Nov · 14:00 · WTC 2", or just the day it was added for unscheduled ones. */
export function whenLine(l) {
  if (!l.starts) return `Added ${shortDate(l.created)}`;
  const end = l.ends ? `–${time(l.ends)}` : '';
  const day = dayKey(l.starts) === dayKey(new Date().toISOString()) ? 'Today' : `${dayLabel(l.starts)}`;
  return [`${day} · ${time(l.starts)}${end}`, l.room].filter(Boolean).join(' · ');
}

function lectureRow(l) {
  const live = l.state === 'live';
  const href = live && (l.enrolled || l.teaches) ? `/live/${l.course.id}` : `/courses/${l.course.id}`;
  let action = '';
  if (isLecturer()) {
    action = live ? html`<a class="btn btn-sm btn-primary" href="/live/${l.course.id}">Resume</a>`
      : l.state === 'upcoming' || l.state === 'open' ? html`<a class="btn btn-sm" href="/live/${l.course.id}?lecture=${l.id}" data-start="${l.id}" data-course="${l.course.id}">Start</a>`
        : l.lastSession ? html`<a class="btn btn-sm btn-ghost" href="/lectures/review/${l.lastSession}">Review</a> <a class="btn btn-sm" href="/live/${l.course.id}?lecture=${l.id}" data-start="${l.id}" data-course="${l.course.id}">Go live again</a>` : '';
  } else if (l.state === 'past' && l.enrolled && l.lastSession) {
    action = html`<a class="btn btn-sm" href="/lectures/review/${l.lastSession}">Recap</a>`;
  } else if (!l.enrolled) {
    action = html`<button class="btn btn-sm ${live ? 'btn-primary' : ''}" data-join="${l.course.id}" data-live="${live ? '1' : ''}">Join course</button>`;
  } else if (live) {
    action = html`<a class="btn btn-sm btn-primary" href="/live/${l.course.id}">Join</a>`;
  }
  return html`<div class="list-row lecture-row ${live ? 'is-live' : ''}">
    ${courseTile(l.course.code)}
    <a class="body" href="${href}" style="color:inherit;text-decoration:none">
      <span class="title">${l.topic}${live ? html` <span class="chip success"><span class="dot live"></span>Live</span>` : ''}</span>
      <span class="sub">${whenLine(l)}</span>
      <span class="sub">${l.course.code} · ${l.course.title}${l.course.lecturer ? ` · ${l.course.lecturer}` : ''}${l.teaches && l.struggles ? ` · class got lost ${l.struggles === 1 ? 'once' : `${l.struggles} times`}` : ''}</span>
    </a>
    <span class="trail">${action}</span>
  </div>`;
}

const section = (title, items) => (items.length ? html`<section class="card flush"><div class="card-head"><h2>${title}</h2></div><div class="list" style="padding-bottom:8px">${items.map(lectureRow)}</div></section>` : '');

/** The first thing on the page: a lecturer goes live in one step, a student joins with the code on the screen. */
function startCard(courses) {
  if (!isLecturer()) {
    return html`<section class="card stack lecture-start"><div><h2>Join a lecture</h2><p class="small muted">In the lecture room? Type the code your lecturer shows on the screen.</p></div>${joinForm()}</section>`;
  }
  if (!courses.length) return '';
  const running = courses.find((c) => c.running);
  return html`<section class="card stack lecture-start">
    <div><h2>Go live</h2><p class="small muted">Start a live lecture now. Students join with a code on the screen and tell you how it’s going.</p></div>
    ${running ? html`<a class="btn btn-primary btn-lg" href="/live/${running.id}">${icon('presentation', 18)} Back to ${running.code}, live now</a>` : html`<form class="join-form" data-go-live>
      <label class="field"><span>Course</span><select class="select" name="course">${courses.map((c) => html`<option value="${c.id}">${c.code} · ${c.title}</option>`)}</select></label>
      <button class="btn btn-primary">${icon('play', 17)} Set up lecture</button></form>`}
  </section>`;
}

export default {
  title: 'Lectures',
  async load() {
    const [feed, mine] = await Promise.all([api.get('/lectures/feed'), isLecturer() ? api.get('/live/mine').catch(() => ({ courses: [] })) : { courses: [] }]);
    return { ...feed, courses: mine.courses };
  },
  render({ lectures, courses }) {
    const live = lectures.filter((l) => l.state === 'live');
    const next = lectures.filter((l) => l.state === 'upcoming' || l.state === 'open');
    const past = lectures.filter((l) => l.state === 'past');
    return html`${pageHead({ title: 'Lectures', subtitle: isLecturer() ? 'Go live, or start one of your scheduled lectures.' : 'What’s on now and coming up. Join with the code in the room, or join a course from the list.' })}
      <div class="stack stagger">
        ${startCard(courses)}
        ${lectures.length ? html`${section('Happening now', live)}${section('Coming up', next)}${section('Earlier', past)}`
          : html`<div class="card">${empty({ icon: 'presentation', title: 'No lectures yet', body: isLecturer() ? 'Schedule a lecture in one of your courses, or start one live.' : 'When a lecturer schedules or starts a lecture, it appears here with its date, time and room.', action: html`<a class="btn btn-primary" href="/courses">${isLecturer() ? 'Go to teaching' : 'Browse courses'}</a>` })}</div>`}
      </div>`;
  },
  mount(root, data, ctx) {
    ctx.live.on('live.started', () => ctx.refresh());
    ctx.live.on('live.ended', () => ctx.refresh());
    const offStart = on(root, 'click', '[data-start]', async (e, button) => {
      e.preventDefault();
      button.disabled = true;
      try {
        await api.post('/live/sessions', { course_id: Number(button.dataset.course), lecture_id: Number(button.dataset.start) });
        ctx.navigate(`/live/${button.dataset.course}`);
      } catch (error) {
        button.disabled = false;
        toastError(error);
      }
    });
    const offJoin = on(root, 'click', '[data-join]', (e, button) => busy(button, async () => {
      try {
        await api.post(`/courses/${button.dataset.join}/enroll`);
        toast('Joined', 'success', { duration: 1600 });
        if (button.dataset.live) ctx.navigate(`/live/${button.dataset.join}`);
        else ctx.refresh();
      } catch (error) {
        toastError(error);
      }
    }));
    const offCode = mountJoinForm(root, ctx.navigate);
    const offGo = on(root, 'submit', '[data-go-live]', (e, form) => {
      e.preventDefault();
      ctx.navigate(`/live/${form.course.value}`);
    });
    return () => {
      offStart();
      offJoin();
      offCode();
      offGo();
    };
  },
};
