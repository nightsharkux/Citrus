import { html, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session } from '../core/store.js';
import { pageHead, row, empty, courseTile } from '../core/components.js';
import { plural } from '../core/format.js';
import { sheet, onSubmit, toast, toastError, busy } from '../core/ui.js';

async function load() {
  const role = session.user.role;
  const [courses, integrations, people] = await Promise.all([
    api.get('/courses'),
    api.get('/integrations').catch(() => null),
    role === 'admin' ? api.get('/admin/users') : Promise.resolve({ users: [] }),
  ]);
  let moodle = null;
  if (integrations?.moodle.connected) moodle = await api.get('/integrations/moodle/courses').catch(() => ({ courses: [], error: true }));
  return { role, courses: courses.courses, moodle, integrations, lecturers: people.users.filter((u) => u.role !== 'student') };
}

function moodleCard(data) {
  if (!data.integrations?.moodle.configured) return '';
  if (!data.moodle) {
    return html`<section class="card tight spread"><div class="cluster"><span class="tile info">${icon('link', 18)}</span><div><strong>Connect Moodle</strong><p class="small muted">See your Moodle course pages alongside Campus OS.</p></div></div><a class="btn btn-sm" href="/settings/connections">Connect</a></section>`;
  }
  return html`<section class="card flush"><div class="card-head"><h2>From Moodle</h2><span class="chip info">Linked</span></div>
    ${data.moodle.courses.length ? html`<div class="list" style="padding-bottom:8px">${data.moodle.courses.map((c) => html`<a class="list-row" href="${c.url}" target="_blank" rel="noopener">${courseTile(c.shortName)}<span class="body"><span class="title">${c.name}</span><span class="sub">${c.shortName}${c.progress !== null ? ` · ${c.progress}% complete` : ''}</span></span><span class="trail">${icon('external', 16)}</span></a>`)}</div>`
      : html`<p class="muted small" style="padding:0 20px 18px">${data.moodle.error ? 'Moodle could not be reached right now.' : 'No Moodle courses found.'}</p>`}
  </section>`;
}

export default {
  title: () => (session.user.role === 'lecturer' ? 'Teaching' : 'Courses'),
  load,
  render(data) {
    const { role, courses } = data;
    if (role === 'student') {
      const mine = courses.filter((c) => c.enrolled);
      const others = courses.filter((c) => !c.enrolled);
      return html`
        ${pageHead({ title: 'Courses', subtitle: 'Join a course to rate topics, answer concept checks and see its schedule.' })}
        <div class="stack stagger">
          <section class="card flush"><div class="card-head"><h2>Your courses</h2><span class="chip">${mine.length}</span></div>
            ${mine.length ? html`<div class="list" style="padding-bottom:8px">${mine.map((c) => row({ href: `/courses/${c.id}`, tile: courseTile(c.code), title: c.title, sub: `${c.code} · ${c.lecturer || 'Lecturer to be announced'}` }))}</div>`
              : empty({ icon: 'book', title: 'You haven’t joined a course yet', body: 'Find yours below.' })}
          </section>
          ${moodleCard(data)}
          <section class="card flush"><div class="card-head"><h2>Browse</h2><div class="search-input" style="width:min(280px,50vw)">${icon('search', 16)}<input class="input" data-filter placeholder="Search courses" style="height:36px;min-height:36px"></div></div>
            ${others.length ? html`<div class="list" style="padding-bottom:8px" data-browse>${others.map((c) => html`<div class="list-row" data-name="${`${c.code} ${c.title}`.toLowerCase()}">${courseTile(c.code)}<span class="body"><span class="title">${c.title}</span><span class="sub">${c.code} · ${c.lecturer || 'Lecturer to be announced'}</span></span><span class="trail"><button class="btn btn-sm btn-primary" data-enroll="${c.id}">Join</button></span></div>`)}</div>`
              : html`<p class="muted small" style="padding:0 20px 20px">You’ve joined every available course.</p>`}
          </section>
        </div>`;
    }

    const isAdmin = role === 'admin';
    return html`
      ${pageHead({ title: isAdmin ? 'Courses' : 'Teaching', subtitle: isAdmin ? 'Create courses and assign lecturers.' : 'Your courses, lectures and live understanding.', actions: html`<button class="btn btn-primary" data-new-course>${icon('plus', 17)} New course</button>` })}
      <div class="stack stagger">
        <section class="card flush">
          ${courses.length ? html`<div class="list" style="padding:8px 0">${courses.map((c) => html`
            <div class="list-row">${courseTile(c.code)}
              <a class="body" href="/courses/${c.id}" style="color:inherit;text-decoration:none"><span class="title">${c.title}</span><span class="sub">${c.code} · ${plural(c.enrolled_count || 0, 'student')}${isAdmin ? ` · ${c.lecturer || 'No lecturer'}` : ''}</span></a>
              <span class="trail">${isAdmin ? html`<button class="btn btn-sm" data-manage="${c.id}">Manage</button>` : ''}<a class="btn btn-sm btn-ghost btn-icon" href="/courses/${c.id}" aria-label="Open">${icon('chevron-right', 18)}</a></span>
            </div>`)}</div>`
            : empty({ icon: 'book', title: 'No courses yet', body: isAdmin ? 'Create the first course, then assign a lecturer.' : 'Create your first course. Students can find it and join it themselves.', action: html`<button class="btn btn-primary" data-new-course>Create a course</button>` })}
        </section>
        ${moodleCard(data)}
      </div>`;
  },
  mount(root, data, ctx) {
    const offs = [
      on(root, 'input', '[data-filter]', (e) => {
        const q = e.target.value.trim().toLowerCase();
        root.querySelectorAll('[data-browse] [data-name]').forEach((r) => r.classList.toggle('hidden', !r.dataset.name.includes(q)));
      }),
      on(root, 'click', '[data-enroll]', (e, b) => busy(b, async () => {
        try {
          await api.post(`/courses/${b.dataset.enroll}/enroll`);
          toast('Joined', 'success');
          ctx.refresh();
        } catch (error) {
          toastError(error);
        }
      })),
      on(root, 'click', '[data-new-course]', () => sheet({
        title: 'New course',
        content: html`<form class="form" id="course-form">
          <label class="field"><span>Course title</span><input class="input" name="title" required minlength="3" placeholder="Algorithms and Data Structures" autofocus></label>
          <label class="field"><span>Course code</span><input class="input" name="code" required minlength="2" maxlength="30" placeholder="DTM-ADS"></label>
          <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Create course</button></div>
        </form>`,
        onMount(el, close) {
          onSubmit($('#course-form', el), async (v) => {
            await api.post('/courses', v);
            close();
            ctx.refresh();
            return 'Course created';
          });
        },
      })),
      on(root, 'click', '[data-manage]', (e, b) => {
        const course = data.courses.find((c) => c.id === Number(b.dataset.manage));
        sheet({
          title: `Manage ${course.code}`,
          content: html`<form class="form" id="manage-form">
            <label class="field"><span>Title</span><input class="input" name="title" value="${course.title}" required minlength="3"></label>
            <label class="field"><span>Code</span><input class="input" name="code" value="${course.code}" required minlength="2"></label>
            <label class="field"><span>Lecturer</span><select class="select" name="lecturer_id"><option value="">Not assigned</option>${data.lecturers.map((l) => html`<option value="${l.id}" ${l.id === course.lecturer_id ? 'selected' : ''}>${l.name} · ${l.role}</option>`)}</select></label>
            <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Save</button></div>
          </form>`,
          onMount(el, close) {
            onSubmit($('#manage-form', el), async (v) => {
              await api.patch(`/courses/${course.id}`, { title: v.title, code: v.code });
              await api.post('/admin/assign', { course_id: course.id, lecturer_id: v.lecturer_id || null });
              close();
              ctx.refresh();
              return 'Course updated';
            });
          },
        });
      }),
    ];
    return () => offs.forEach((off) => off());
  },
};
