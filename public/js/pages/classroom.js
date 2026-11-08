/**
 * Classroom (lecturers & admins): confirm card taps from readers/pucks, run the
 * active session, set room status (mirrored on door lights) and see devices.
 */
import { html, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { pageHead, empty, roomChip, ROOM_LABELS } from '../core/components.js';
import { ago, time } from '../core/format.js';
import { sheet, onSubmit, toast, toastError, busy } from '../core/ui.js';
import { debounce } from '../core/live.js';
import { navigate } from '../core/router.js';

const STATUSES = Object.keys(ROOM_LABELS);
const KIND_LABEL = { puck: 'Voice puck', nfc_reader: 'Card reader', door_light: 'Door light', display: 'Display' };

/** Sheet shown when you tap your card: confirm (optionally start a check-in) or decline. */
export async function openActivation(activationId) {
  let data;
  try {
    data = await api.get('/activations');
  } catch {
    return;
  }
  const a = data.activations.find((x) => x.id === Number(activationId) && x.status === 'pending');
  if (!a) return;
  sheet({
    title: `Start session in ${a.room || a.device}?`,
    content: html`<form class="form" id="activation-form">
      <div class="notice accent">${icon('nfc', 18)}<span>Your card was just tapped on <strong>${a.device}</strong>. Only confirm if that was you.</span></div>
      ${data.courses.length ? html`<label class="field"><span>Course</span><select class="select" name="course_id"><option value="">No course — just this room</option>${data.courses.map((c) => html`<option value="${c.id}">${c.code} · ${c.title}</option>`)}</select></label>
        <label class="check"><input type="checkbox" name="open_participation" checked> Open a check-in with a live code</label>` : ''}
      <label class="field"><span>Room status</span><select class="select" name="room_status">${STATUSES.map((s) => html`<option value="${s}" ${s === 'quiet' ? 'selected' : ''}>${ROOM_LABELS[s]}</option>`)}</select></label>
      <div class="form-actions"><button type="button" class="btn btn-danger" data-deny style="margin-right:auto">That wasn’t me</button><button type="button" class="btn btn-ghost" data-close>Later</button><button class="btn btn-primary">Confirm</button></div>
    </form>`,
    onMount(el, close) {
      onSubmit($('#activation-form', el), async (v) => {
        const r = await api.post(`/activations/${a.id}`, { decision: 'confirm', course_id: v.course_id ? Number(v.course_id) : null, open_participation: v.open_participation !== false, room_status: v.room_status });
        close();
        if (r.sessionId) navigate(`/participation/${r.sessionId}`);
        else if (location.pathname === '/classroom') navigate('/classroom', { replace: true });
        return 'Session started';
      });
      el.querySelector('[data-deny]').addEventListener('click', async () => {
        await api.post(`/activations/${a.id}`, { decision: 'deny' }).catch(toastError);
        close();
        toast('Declined. If someone else has your card, tell your administrator.', 'info', { duration: 6000 });
      });
    },
  });
}

export default {
  title: 'Classroom',
  roles: ['lecturer', 'admin'],
  async load() {
    const [activations, notices, devices] = await Promise.all([api.get('/activations'), api.get('/notices'), api.get('/devices')]);
    return { ...activations, notices: notices.notices, devices: devices.devices };
  },
  render(d) {
    const pending = d.activations.filter((a) => a.status === 'pending');
    const active = d.activations.filter((a) => a.status === 'confirmed');
    const rooms = [...new Set([...d.devices.map((x) => x.room).filter(Boolean), ...d.notices.map((n) => n.room)])].sort();
    return html`
      ${pageHead({ title: 'Classroom', subtitle: 'Start sessions with your card, set the room status and keep an eye on classroom devices.', actions: html`<button class="btn btn-primary" data-set-room>${icon('door', 17)} Set room status</button>` })}
      <div class="stack stagger">
        ${pending.map((a) => html`<section class="card activation-card"><div class="spread"><div class="cluster"><span class="tile warning">${icon('nfc', 20)}</span><div><strong>Card tapped at ${a.room || a.device}</strong><p class="small muted">${ago(a.created)} · expires at ${time(a.expires)}</p></div></div><button class="btn btn-primary" data-confirm="${a.id}">Review</button></div></section>`)}
        ${active.length ? html`<section class="card flush"><div class="card-head"><h2>Active sessions</h2></div><div class="list" style="padding-bottom:8px">${active.map((a) => html`<div class="list-row">
          <span class="tile success">${icon('radio', 18)}</span>
          <span class="body"><span class="title">${a.room || a.device}${a.course ? ` · ${a.course.code}` : ''}</span><span class="sub">Started ${ago(a.created)} via ${a.device}</span></span>
          <span class="trail">${a.sessionId ? html`<a class="btn btn-sm" href="/participation/${a.sessionId}">Check-in</a>` : ''}<button class="btn btn-sm btn-danger" data-end="${a.id}">End</button></span>
        </div>`)}</div></section>` : ''}
        <div class="grid-2" style="align-items:start">
          <section class="card flush"><div class="card-head"><h2>Rooms</h2></div>
            ${d.notices.length ? html`<div class="list" style="padding-bottom:8px">${d.notices.map((n) => html`<button class="list-row" data-room="${n.room}" data-status="${n.status}" data-note="${n.note}">
              <span class="tile ${{ open: 'success', quiet: 'warning', do_not_disturb: 'danger', consultation: 'info' }[n.status]}">${icon('door', 18)}</span>
              <span class="body"><span class="title">${n.room}</span><span class="sub">${n.note || 'No note'} · ${ago(n.updated)}</span></span><span class="trail">${roomChip(n.status)}</span></button>`)}</div>`
              : empty({ icon: 'door', title: 'No rooms set yet', body: 'Set a status so students know whether to come in.' })}
          </section>
          <section class="card flush"><div class="card-head"><h2>Devices</h2>${d.devices.length ? '' : html`<span class="chip">None yet</span>`}</div>
            ${d.devices.length ? html`<div class="list" style="padding-bottom:8px">${d.devices.map((x) => html`<div class="list-row">
              <span class="tile ${x.online ? 'success' : 'neutral'}">${icon(x.kind === 'door_light' ? 'bulb' : x.kind === 'nfc_reader' ? 'nfc' : x.kind === 'display' ? 'monitor' : 'radio', 18)}</span>
              <span class="body"><span class="title">${x.name}</span><span class="sub">${KIND_LABEL[x.kind]}${x.room ? ` · ${x.room}` : ''}</span></span>
              <span class="trail"><span class="chip ${x.online ? 'success' : ''}"><span class="dot"></span>${x.online ? 'Online' : 'Offline'}</span></span></div>`)}</div>`
              : html`<p class="small muted" style="padding:0 20px 20px">When your university registers a card reader, voice puck or door light, you can start sessions by tapping your staff card — and confirming here.</p>`}
          </section>
        </div>
        <p class="small faint">A card tap only proposes a sign-in. Nothing starts until you confirm it in this app.</p>
      </div>`;
  },
  mount(root, d, ctx) {
    const offs = [
      on(root, 'click', '[data-confirm]', (e, b) => openActivation(b.dataset.confirm)),
      on(root, 'click', '[data-end]', (e, b) => busy(b, () => api.post(`/activations/${b.dataset.end}/end`).then(() => {
        toast('Session ended', 'success');
        ctx.refresh();
      }, toastError))),
      on(root, 'click', '[data-set-room], [data-room]', (e, b) => roomSheet(b.dataset.room || '', b.dataset.status || 'open', b.dataset.note || '', d, ctx)),
    ];
    const target = ctx.query.get('activation');
    if (target) {
      history.replaceState({}, '', '/classroom');
      openActivation(target);
    }
    ctx.live.on('activation', debounce(ctx.refresh, 400));
    ctx.live.on('room.updated', debounce(ctx.refresh, 400));
    return () => offs.forEach((off) => off());
  },
};

function roomSheet(room, status, note, d, ctx) {
  const known = [...new Set([...d.devices.map((x) => x.room).filter(Boolean), ...d.notices.map((n) => n.room)])];
  sheet({
    title: room ? `Room ${room}` : 'Set room status',
    content: html`<form class="form" id="room-form">
      <label class="field"><span>Room</span><input class="input" name="room" value="${room}" list="known-rooms" required placeholder="MF2" ${room ? '' : 'autofocus'}><datalist id="known-rooms">${known.map((r) => html`<option value="${r}">`)}</datalist></label>
      <div class="field"><span>Status</span><div class="choice-grid two">${STATUSES.map((s) => html`<label class="choice"><input type="radio" name="status" value="${s}" ${s === status ? 'checked' : ''}>${roomChip(s)}</label>`)}</div></div>
      <label class="field"><span>Note (optional)</span><input class="input" name="note" value="${note}" maxlength="240" placeholder="Exam until 12:00"></label>
      <p class="hint">Door lights registered to this room switch colour automatically.</p>
      <div class="form-actions">${room ? html`<button type="button" class="btn btn-ghost" data-clear style="margin-right:auto">Remove</button>` : ''}<button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Update</button></div>
    </form>`,
    onMount(el, close) {
      onSubmit($('#room-form', el), async (v) => {
        await api.post('/notices', v);
        close();
        ctx.refresh();
        return 'Room updated';
      });
      el.querySelector('[data-clear]')?.addEventListener('click', async () => {
        await api.del(`/notices/${encodeURIComponent(room)}`).catch(toastError);
        close();
        ctx.refresh();
      });
    },
  });
}
