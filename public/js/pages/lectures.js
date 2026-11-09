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
      : l.state === 'upcoming' || l.state === 'open' ? html`<a class="btn btn-sm" href="/live/${l.course.id}?lecture=${l.id}">Start</a>` : '';
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
      <span class="sub">${l.course.code} · ${l.course.title}${l.course.lecturer ? ` · ${l.course.lecturer}` : ''}</span>
    </a>
    <span class="trail">${action}</span>
  </div>`;
}

const section = (title, items) => (items.length ? html`<section class="card flush"><div class="card-head"><h2>${title}</h2></div><div class="list" style="padding-bottom:8px">${items.map(lectureRow)}</div></section>` : '');

export default {
  title: 'Lectures',
  async load() {
    return api.get('/lectures/feed');
  },
  render({ lectures }) {
    const live = lectures.filter((l) => l.state === 'live');
    const next = lectures.filter((l) => l.state === 'upcoming' || l.state === 'open');
    const past = lectures.filter((l) => l.state === 'past');
    return html`${pageHead({ title: 'Lectures', subtitle: isLecturer() ? 'Your lectures: start one when you’re ready.' : 'What’s on now and coming up. Join a course to take part.' })}
      <div class="stack stagger">
        ${lectures.length ? html`${section('Happening now', live)}${section('Coming up', next)}${section('Earlier', past)}`
          : html`<div class="card">${empty({ icon: 'presentation', title: 'No lectures yet', body: isLecturer() ? 'Schedule a lecture in one of your courses, or start one live.' : 'When a lecturer schedules or starts a lecture, it appears here with its date, time and room.', action: html`<a class="btn btn-primary" href="/courses">${isLecturer() ? 'Go to teaching' : 'Browse courses'}</a>` })}</div>`}
      </div>`;
  },
  mount(root, data, ctx) {
    ctx.live.on('live.started', () => ctx.refresh());
    ctx.live.on('live.ended', () => ctx.refresh());
    return on(root, 'click', '[data-join]', (e, button) => busy(button, async () => {
      try {
        await api.post(`/courses/${button.dataset.join}/enroll`);
        toast('Joined', 'success', { duration: 1600 });
        if (button.dataset.live) ctx.navigate(`/live/${button.dataset.join}`);
        else ctx.refresh();
      } catch (error) {
        toastError(error);
      }
    }));
  },
};
