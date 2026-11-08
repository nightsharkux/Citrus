/** Schedule: week strip + agenda, add/edit events, ICS import and a subscribable feed. */
import { html, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session } from '../core/store.js';
import { pageHead, empty } from '../core/components.js';
import { time, dayKey, weekday, shortDate, humanize, longDay } from '../core/format.js';
import { sheet, onSubmit, toast, confirm, copyText, toastError } from '../core/ui.js';

const KINDS = ['lecture', 'seminar', 'lab', 'exam', 'deadline', 'event', 'personal'];
const TONE = { exam: 'danger', deadline: 'warning', personal: 'neutral', event: 'info', lab: 'success', seminar: '' , lecture: '' };
const pad = (n) => String(n).padStart(2, '0');

function weekStart(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return d;
}

export default {
  title: 'Schedule',
  layout: 'wide',
  async load(ctx) {
    const week = Number(ctx.query.get('week') || 0);
    const courseId = ctx.query.get('course');
    const start = weekStart(week);
    const end = new Date(start.getTime() + 7 * 86_400_000);
    const [schedule, courses] = await Promise.all([
      api.get(`/timetable?from=${start.toISOString()}&to=${end.toISOString()}${courseId ? `&course_id=${courseId}` : ''}`),
      api.get('/courses'),
    ]);
    const teachable = session.user.role === 'student' ? [] : courses.courses;
    const course = courseId ? courses.courses.find((c) => c.id === Number(courseId)) : null;
    return { week, start, events: schedule.events, feed: schedule.feed, teachable, course };
  },
  render(data) {
    const days = Array.from({ length: 7 }, (_, i) => new Date(data.start.getTime() + i * 86_400_000));
    const byDay = new Map(days.map((d) => [dayKey(d.toISOString()), []]));
    for (const e of data.events) byDay.get(dayKey(e.starts))?.push(e);
    const today = dayKey(new Date().toISOString());
    const qs = (week) => `/schedule?week=${week}${data.course ? `&course=${data.course.id}` : ''}`;
    const rangeLabel = `${shortDate(days[0].toISOString())} – ${shortDate(days[6].toISOString())}`;

    return html`
      ${pageHead({
        back: data.course ? { href: `/courses/${data.course.id}`, label: data.course.code } : null,
        title: data.course ? `${data.course.code} schedule` : 'Schedule',
        subtitle: rangeLabel,
        actions: html`
          <button class="btn" data-subscribe>${icon('link', 17)} Subscribe</button>
          <button class="btn" data-import>${icon('upload', 17)} Import</button>
          <button class="btn btn-primary" data-add>${icon('plus', 17)} Add</button>`,
      })}
      <section class="card week-strip">
        <a class="btn btn-ghost btn-icon" href="${qs(data.week - 1)}" aria-label="Previous week">${icon('chevron-left', 20)}</a>
        <div class="week-days">${days.map((d) => {
          const key = dayKey(d.toISOString());
          const count = byDay.get(key).length;
          return html`<button class="week-day ${key === today ? 'is-today' : ''}" data-jump="${key}"><span>${weekday(d.toISOString())}</span><b>${d.getDate()}</b><i class="${count ? 'has' : ''}"></i></button>`;
        })}</div>
        <a class="btn btn-ghost btn-icon" href="${qs(data.week + 1)}" aria-label="Next week">${icon('chevron-right', 20)}</a>
        ${data.week !== 0 ? html`<a class="btn btn-sm" href="${qs(0)}">Today</a>` : ''}
      </section>
      <div class="agenda stagger">
        ${data.events.length ? days.map((d) => {
          const key = dayKey(d.toISOString());
          const list = byDay.get(key);
          return html`<section class="agenda-day ${key === today ? 'is-today' : ''}" id="day-${key}">
            <h3>${key === today ? 'Today' : longDay(d.toISOString())}</h3>
            ${list.length ? html`<div class="card flush"><div class="list">${list.map((e) => eventRow(e))}</div></div>` : html`<p class="faint small agenda-free">Nothing scheduled</p>`}
          </section>`;
        }) : html`<div class="card">${empty({ icon: 'calendar', title: 'A clear week', body: session.user.role === 'student' ? 'Sessions from your courses appear here automatically. You can also add your own or import a calendar file.' : 'Add teaching sessions for your courses and students see them right away.', action: html`<button class="btn btn-primary" data-add>${icon('plus', 16)} Add to schedule</button>` })}</div>`}
      </div>`;
  },
  mount(root, data, ctx) {
    const offs = [
      on(root, 'click', '[data-jump]', (e, b) => document.getElementById(`day-${b.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })),
      on(root, 'click', '[data-add]', () => editSheet(null, data, ctx)),
      on(root, 'click', '[data-event]', (e, b) => {
        const ev = data.events.find((x) => x.key === b.dataset.event);
        if (ev?.editable) editSheet(ev, data, ctx);
        else if (ev?.course) ctx.navigate(`/courses/${ev.course.id}`);
      }),
      on(root, 'click', '[data-import]', () => importSheet(data, ctx)),
      on(root, 'click', '[data-subscribe]', () => subscribeSheet(data, ctx)),
    ];
    if (ctx.query.get('new') === '1') {
      history.replaceState({}, '', '/schedule');
      editSheet(null, data, ctx);
    }
    const todayEl = $('.agenda-day.is-today', root);
    if (todayEl && data.week === 0 && window.innerWidth < 900) setTimeout(() => todayEl.scrollIntoView({ block: 'start' }), 50);
    return () => offs.forEach((off) => off());
  },
};

function eventRow(e) {
  return html`<button class="list-row event-row" data-event="${e.key}">
    <span class="event-time"><b>${time(e.starts)}</b><small>${time(e.ends)}</small></span>
    <span class="event-bar ${TONE[e.kind] || ''}"></span>
    <span class="body"><span class="title">${e.title}</span><span class="sub">${[e.location, e.course?.code, e.recurring ? 'Weekly' : null].filter(Boolean).join(' · ') || humanize(e.scope)}</span></span>
    <span class="trail">${e.kind !== 'lecture' ? html`<span class="chip ${TONE[e.kind] || ''}">${humanize(e.kind)}</span>` : ''}${e.editable ? icon('edit', 15) : ''}</span>
  </button>`;
}

function scopeOptions(data, current) {
  const opts = [html`<option value="personal">Just me</option>`];
  for (const c of data.teachable) opts.push(html`<option value="course:${c.id}" ${current === `course:${c.id}` ? 'selected' : ''}>${c.code} · students of this course</option>`);
  if (session.user.role === 'admin') opts.push(html`<option value="institution" ${current === 'institution' ? 'selected' : ''}>Everyone at the university</option>`);
  return opts;
}

function editSheet(ev, data, ctx) {
  const start = ev ? new Date(ev.starts) : (() => { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; })();
  const end = ev ? new Date(ev.ends) : new Date(start.getTime() + 90 * 60_000);
  const dateValue = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  const defaultScope = data.course && data.teachable.some((c) => c.id === data.course.id) ? `course:${data.course.id}` : 'personal';
  sheet({
    title: ev ? 'Edit event' : 'Add to schedule',
    content: html`<form class="form" id="event-form">
      <label class="field"><span>Title</span><input class="input" name="title" value="${ev?.title || ''}" required minlength="2" placeholder="Algorithms lecture" autofocus></label>
      <div class="input-row">
        <label class="field"><span>Type</span><select class="select" name="kind">${KINDS.map((k) => html`<option value="${k}" ${(ev?.kind || (session.user.role === 'student' ? 'personal' : 'lecture')) === k ? 'selected' : ''}>${humanize(k)}</option>`)}</select></label>
        ${ev ? '' : html`<label class="field"><span>Visible to</span><select class="select" name="scope">${scopeOptions(data, defaultScope)}</select></label>`}
      </div>
      <div class="input-row">
        <label class="field"><span>Date</span><input class="input" type="date" name="date" value="${dateValue}" required></label>
        <label class="field"><span>From</span><input class="input" type="time" name="from" value="${pad(start.getHours())}:${pad(start.getMinutes())}" required></label>
        <label class="field"><span>To</span><input class="input" type="time" name="to" value="${pad(end.getHours())}:${pad(end.getMinutes())}" required></label>
      </div>
      <label class="field"><span>Location</span><input class="input" name="location" value="${ev?.location || ''}" placeholder="Room MF2"></label>
      <label class="check"><input type="checkbox" name="weekly" ${ev?.recurring ? 'checked' : ''}> Repeats every week</label>
      <label class="field" data-until><span>Repeat until (optional)</span><input class="input" type="date" name="until"></label>
      <label class="field"><span>Notes</span><textarea class="textarea" name="notes" placeholder="Anything people should know" style="min-height:70px">${ev?.notes || ''}</textarea></label>
      <div class="form-actions">${ev ? html`<button type="button" class="btn btn-danger" data-delete style="margin-right:auto">Delete</button>` : ''}<button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">${ev ? 'Save' : 'Add'}</button></div>
    </form>`,
    onMount(el, close) {
      onSubmit($('#event-form', el), async (v) => {
        const starts = new Date(`${v.date}T${v.from}`);
        let ends = new Date(`${v.date}T${v.to}`);
        if (ends <= starts) ends = new Date(ends.getTime() + 86_400_000);
        const body = { title: v.title, kind: v.kind, location: v.location, notes: v.notes, starts: starts.toISOString(), ends: ends.toISOString(), repeat_weeks: v.weekly ? 1 : 0, until: v.weekly && v.until ? new Date(`${v.until}T23:59`).toISOString() : null };
        if (ev) await api.patch(`/timetable/${ev.id}`, body);
        else {
          const [scope, courseId] = String(v.scope || 'personal').split(':');
          await api.post('/timetable', { ...body, scope, course_id: courseId ? Number(courseId) : undefined });
        }
        close();
        ctx.refresh();
        return ev ? 'Event updated' : 'Added to schedule';
      });
      el.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!(await confirm({ title: 'Delete this event?', message: ev.recurring ? 'This removes every repeat of the event.' : 'This can’t be undone.', confirmLabel: 'Delete', danger: true }))) return;
        await api.del(`/timetable/${ev.id}`).catch(toastError);
        close();
        ctx.refresh();
      });
    },
  });
}

function importSheet(data, ctx) {
  sheet({
    title: 'Import a calendar',
    content: html`<form class="form" id="import-form">
      <p class="muted small">Upload an .ics file exported from your university timetable, Outlook, Google or Apple Calendar. Re-importing the same file updates events instead of duplicating them.</p>
      <label class="field"><span>Calendar file</span><input class="input" type="file" name="file" accept=".ics,text/calendar" required></label>
      <label class="field"><span>Add events for</span><select class="select" name="scope">${scopeOptions(data, 'personal')}</select></label>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Import</button></div>
    </form>`,
    onMount(el, close) {
      onSubmit($('#import-form', el), async (v, form) => {
        const file = form.file.files[0];
        if (!file) throw new Error('Choose a file');
        if (file.size > 900_000) throw new Error('That file is too large (max ~900 KB)');
        const [scope, courseId] = String(v.scope).split(':');
        const r = await api.post('/timetable/import', { ics: await file.text(), scope, course_id: courseId ? Number(courseId) : undefined });
        close();
        ctx.refresh();
        return `${r.imported} added, ${r.updated} updated`;
      });
    },
  });
}

function subscribeSheet(data, ctx) {
  sheet({
    title: 'Subscribe in your calendar app',
    content: html`<div class="stack">
      <p class="muted">Get your Campus OS schedule in Apple Calendar, Google Calendar or Outlook. It updates automatically.</p>
      <div id="feed-box">${data.feed ? html`<div class="notice">${icon('info', 18)}<span>You already have a private link. Creating a new one turns the old link off.</span></div>` : ''}</div>
      <button class="btn btn-primary" data-create>${icon('link', 17)} ${data.feed ? 'Create a new link' : 'Create my private link'}</button>
      ${data.feed ? html`<button class="btn btn-ghost" data-revoke>Turn off my calendar link</button>` : ''}
      <p class="small faint">Anyone with the link can see your schedule, so keep it private.</p>
    </div>`,
    onMount(el, close) {
      el.querySelector('[data-create]').addEventListener('click', async (e) => {
        try {
          const { url } = await api.post('/timetable/feed');
          el.querySelector('#feed-box').innerHTML = html`<div class="code-box"><span>${url}</span><button class="btn btn-sm" data-copy>${icon('copy', 15)} Copy</button></div>`.value;
          el.querySelector('[data-copy]').addEventListener('click', () => copyText(url, 'Calendar link copied'));
          e.target.closest('button').remove();
        } catch (error) {
          toastError(error);
        }
      });
      el.querySelector('[data-revoke]')?.addEventListener('click', async () => {
        await api.del('/timetable/feed');
        toast('Calendar link turned off', 'success');
        close();
        ctx.refresh();
      });
    },
  });
}
