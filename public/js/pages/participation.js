/** Participation sessions list; lecturers can start a new check-in. */
import { html, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { isStaff } from '../core/store.js';
import { pageHead, empty, row } from '../core/components.js';
import { ago, plural } from '../core/format.js';
import { sheet, onSubmit } from '../core/ui.js';

export function newSessionSheet(courses, ctx, defaults = {}) {
  sheet({
    title: 'Start a check-in',
    content: html`<form class="form" id="session-form">
      <label class="field"><span>Course</span><select class="select" name="course_id" required>${courses.map((c) => html`<option value="${c.id}" ${defaults.course_id === c.id ? 'selected' : ''}>${c.code} · ${c.title}</option>`)}</select></label>
      <label class="field"><span>Title</span><input class="input" name="title" required minlength="3" value="${defaults.title || `Lecture · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}"></label>
      <label class="field"><span>Room (optional)</span><input class="input" name="room" placeholder="MF2" value="${defaults.room || ''}"><span class="hint">Students tapping a card on a reader in this room are checked in automatically.</span></label>
      <label class="check"><input type="checkbox" name="require_code" checked> Require the live code shown on your screen</label>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Start</button></div>
    </form>`,
    onMount(el, close) {
      onSubmit($('#session-form', el), async (v) => {
        const r = await api.post('/participation', { ...v, course_id: Number(v.course_id) });
        close();
        ctx.navigate(`/participation/${r.id}`);
      });
    },
  });
}

export default {
  title: () => (isStaff() ? 'Participation' : 'Check-in'),
  async load() {
    return api.get('/participation');
  },
  render(d) {
    const staff = isStaff();
    const open = d.sessions.filter((s) => s.open);
    const closed = d.sessions.filter((s) => !s.open);
    const rowFor = (s) => row({
      href: `/participation/${s.id}`,
      icon: s.open ? 'clipboard' : 'check-circle',
      tone: s.open ? 'success' : 'neutral',
      title: s.title,
      sub: `${s.code}${s.room ? ` · ${s.room}` : ''} · ${staff ? plural(s.checkins, 'check-in') : s.mine ? 'You checked in' : 'Not checked in'} · ${ago(s.created)}`,
      trail: s.open ? (staff || !s.mine ? html`<span class="chip success"><span class="dot live"></span>Open</span>` : html`<span class="chip">${icon('check', 12)} Done</span>`) : '',
    });
    return html`
      ${pageHead({
        title: staff ? 'Participation' : 'Check-in',
        subtitle: staff ? 'Open a session, show the code, and see who’s here in real time.' : 'When your lecturer opens a check-in, enter the code shown in the room.',
        actions: staff ? html`<button class="btn btn-primary" data-new ${d.courses.length ? '' : 'disabled'}>${icon('plus', 17)} Start check-in</button>` : '',
      })}
      <div class="stack stagger">
        <section class="card flush"><div class="card-head"><h2>Open now</h2></div>
          ${open.length ? html`<div class="list" style="padding-bottom:8px">${open.map(rowFor)}</div>` : empty({ icon: 'clipboard', title: 'No open sessions', body: staff ? (d.courses.length ? 'Start one at the beginning of your lecture.' : 'You need an assigned course first.') : 'Nothing to check in to right now.' })}
        </section>
        ${closed.length ? html`<section class="card flush"><div class="card-head"><h2>Earlier</h2></div><div class="list" style="padding-bottom:8px">${closed.slice(0, 20).map(rowFor)}</div></section>` : ''}
        <p class="small faint">Check-ins are participation records. They don’t prove identity or physical presence.</p>
      </div>`;
  },
  mount(root, d, ctx) {
    const off = on(root, 'click', '[data-new]', () => newSessionSheet(d.courses, ctx));
    if (ctx.query.get('new') === '1' && isStaff() && d.courses.length) {
      history.replaceState({}, '', '/participation');
      newSessionSheet(d.courses, ctx);
    }
    ctx.live.on('participation.updated', () => ctx.refresh());
    return off;
  },
};
