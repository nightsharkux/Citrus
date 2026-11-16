/**
 * A participation session. Lecturers see the rotating code (with a countdown
 * ring), a live roster and card pairing; students enter the code to check in.
 */
import { html, render, $, $$, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { pageHead, empty, avatar } from '../core/components.js';
import { ago, humanize } from '../core/format.js';
import { toast, toastError, confirm, sheet, onSubmit, busy } from '../core/ui.js';
import { debounce } from '../core/live.js';

const METHOD = { self_reported: 'Self check-in', code_verified: 'Live code', lecturer_confirmed: 'Marked by lecturer', nfc_assisted_unverified: 'Card (manual)', nfc_device: 'Card reader' };

export default {
  title: (d) => d.session.title,
  async load(ctx) {
    return api.get(`/participation/${ctx.params.id}`);
  },
  render(d) {
    const s = d.session;
    return html`
      ${pageHead({
        back: { href: '/participation', label: d.teacherAccess ? 'Participation' : 'Check-in' },
        title: s.title,
        subtitle: html`<span class="chip accent">${s.course_code}</span> ${s.course_title}${s.room ? ` · ${s.room}` : ''}`,
        actions: d.teacherAccess ? html`${s.open ? html`<button class="btn" data-pair>${icon('nfc', 16)} Link a card</button><button class="btn btn-danger" data-close-session>End check-in</button>` : html`<button class="btn" data-reopen>Reopen</button>`}` : '',
      })}
      ${d.teacherAccess ? teacher(d) : student(d)}`;
  },
  mount(root, d, ctx) {
    return d.teacherAccess ? mountTeacher(root, d, ctx) : mountStudent(root, d, ctx);
  },
};

// ---------------------------------------------------------------- Student

function student(d) {
  const s = d.session;
  if (d.mine) return html`<section class="card center" style="padding:40px 24px">
    <div class="success-burst">${icon('check', 40)}</div>
    <h2 class="mt-16">You’re checked in</h2>
    <p class="muted mt-8">${s.course_code} · ${s.title}</p>
  </section>`;
  if (!s.open) return html`<div class="card">${empty({ icon: 'clock', title: 'This check-in has ended', body: 'Ask your lecturer if you think you were missed.' })}</div>`;
  return html`<section class="card code-entry center">
    <span class="tile lg">${icon('clipboard', 24)}</span>
    <h2 class="mt-16">${s.require_code ? 'Enter the code on the screen' : 'Check in'}</h2>
    <p class="muted mt-8">${s.require_code ? 'It changes every 30 seconds.' : 'Your lecturer hasn’t required a code for this session.'}</p>
    <form id="checkin-form" class="mt-24">
      ${s.require_code ? html`<div class="otp" role="group" aria-label="Six-digit code">${[0, 1, 2, 3, 4, 5].map((i) => html`<input inputmode="numeric" pattern="[0-9]*" maxlength="1" aria-label="Digit ${i + 1}" ${i === 0 ? 'autofocus' : ''}>`)}</div>` : ''}
      <button class="btn btn-primary btn-lg mt-24" style="min-width:220px">Check in</button>
    </form>
    <p class="small faint mt-16">This records participation. It doesn’t prove identity or presence.</p>
  </section>`;
}

function mountStudent(root, d, ctx) {
  const inputs = $$('.otp input', root);
  inputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(-1);
      if (input.value && inputs[i + 1]) inputs[i + 1].focus();
      if (inputs.every((x) => x.value)) $('#checkin-form', root).requestSubmit();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && inputs[i - 1]) inputs[i - 1].focus();
    });
    input.addEventListener('paste', (e) => {
      const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      if (digits.length) {
        e.preventDefault();
        inputs.forEach((x, j) => (x.value = digits[j] || ''));
        if (digits.length === 6) $('#checkin-form', root).requestSubmit();
      }
    });
  });
  onSubmit($('#checkin-form', root), async () => {
    const code = inputs.map((x) => x.value).join('');
    try {
      await api.post(`/participation/${d.session.id}/checkin`, d.session.require_code ? { code } : {});
    } catch (error) {
      inputs.forEach((x) => (x.value = ''));
      inputs[0]?.focus();
      $('.otp', root)?.classList.add('shake');
      setTimeout(() => $('.otp', root)?.classList.remove('shake'), 500);
      throw error;
    }
    ctx.refresh();
    return 'Checked in';
  });
}

// ---------------------------------------------------------------- Lecturer

function teacher(d) {
  const s = d.session;
  const present = d.people.filter((p) => p.checked);
  const absent = d.people.filter((p) => !p.checked);
  return html`<div class="session-grid">
    <div class="stack">
      ${s.open && s.require_code ? html`<section class="card code-display">
        <p class="muted small">Check-in code</p>
        <div class="code-ring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="54" class="track"/><circle cx="60" cy="60" r="54" class="progress" id="code-progress"/></svg><span id="code" class="mono">······</span></div>
        <p class="muted small">Students enter this in Citrus → Check-in</p>
        <button class="btn btn-sm mt-16" data-fullscreen>${icon('monitor', 15)} Show full screen</button>
      </section>` : ''}
      <section class="card">
        <div class="stats" style="grid-template-columns:repeat(2,1fr)">
          <div><div class="stat-value" id="present-count">${present.length}</div><div class="stat-label">Checked in</div></div>
          <div><div class="stat-value">${d.people.length}</div><div class="stat-label">Enrolled</div></div>
        </div>
        <div class="bar mt-16"><span class="got" style="width:${d.people.length ? (100 * present.length) / d.people.length : 0}%"></span></div>
      </section>
    </div>
    <section class="card flush">
      <div class="card-head"><h2>Roster</h2><input class="input" data-roster-filter placeholder="Find a student" style="max-width:220px;height:36px;min-height:36px"></div>
      ${d.people.length ? html`<div class="list roster" style="padding-bottom:8px">
        ${[...present, ...absent].map((p) => html`<div class="list-row" data-name="${p.name.toLowerCase()}">
          ${avatar(p.name)}
          <span class="body"><span class="title">${p.name}</span><span class="sub">${p.checked ? `${METHOD[p.method] || humanize(p.method)} · ${ago(p.created)}` : 'Not checked in'}${p.has_card ? ' · card linked' : ''}</span></span>
          <span class="trail">${p.checked ? html`<span class="chip success">${icon('check', 12)} Here</span>` : s.open ? html`<button class="btn btn-sm" data-mark="${p.id}">Mark present</button>` : ''}</span>
        </div>`)}
      </div>` : empty({ icon: 'users', title: 'No students enrolled', body: 'Students need to join the course before they can check in.' })}
    </section>
  </div>`;
}

function mountTeacher(root, d, ctx) {
  const s = d.session;
  let timer = 0;
  let expiresAt = 0;
  let period = 30_000;
  const circumference = 2 * Math.PI * 54;

  async function fetchCode() {
    try {
      const r = await api.get(`/participation/${s.id}/code`);
      const el = $('#code', root);
      if (el) el.textContent = `${r.code.slice(0, 3)} ${r.code.slice(3)}`;
      expiresAt = Date.now() + r.expiresIn;
      period = r.period;
      if ($('#fs-code')) $('#fs-code').textContent = `${r.code.slice(0, 3)} ${r.code.slice(3)}`;
    } catch (error) {
      clearInterval(timer);
    }
  }
  function tick() {
    const left = Math.max(0, expiresAt - Date.now());
    const progress = $('#code-progress', root);
    if (progress) progress.style.strokeDashoffset = String(circumference * (1 - left / period));
    if (left <= 0) fetchCode();
  }
  if (s.open && s.require_code) {
    const progress = $('#code-progress', root);
    progress.style.strokeDasharray = String(circumference);
    fetchCode();
    timer = setInterval(tick, 250);
  }

  const offs = [
    on(root, 'input', '[data-roster-filter]', (e) => {
      const q = e.target.value.trim().toLowerCase();
      $$('.roster [data-name]', root).forEach((r) => r.classList.toggle('hidden', !r.dataset.name.includes(q)));
    }),
    on(root, 'click', '[data-mark]', (e, b) => busy(b, () => api.post(`/participation/${s.id}/checkin`, { user_id: Number(b.dataset.mark) }).then(ctx.refresh, toastError))),
    on(root, 'click', '[data-close-session]', async () => {
      if (!(await confirm({ title: 'End this check-in?', message: 'Students won’t be able to check in anymore. You can reopen it later.', confirmLabel: 'End check-in' }))) return;
      await api.post(`/participation/${s.id}/close`).catch(toastError);
      ctx.refresh();
    }),
    on(root, 'click', '[data-reopen]', () => api.post(`/participation/${s.id}/reopen`).then(ctx.refresh, toastError)),
    on(root, 'click', '[data-fullscreen]', () => {
      const overlay = document.createElement('div');
      overlay.className = 'fullscreen-code';
      render(overlay, html`<div><p>${s.course_code} · ${s.title}</p><div id="fs-code" class="mono">${$('#code', root).textContent}</div><p>Open Citrus → Check-in and enter this code</p><button class="btn btn-glass mt-24">Close</button></div>`);
      document.body.append(overlay);
      overlay.requestFullscreen?.().catch(() => {});
      overlay.querySelector('button').addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        overlay.remove();
      });
    }),
    on(root, 'click', '[data-pair]', () => pairSheet(d, ctx)),
  ];
  ctx.live.on('participation.updated', debounce((e) => e.sessionId === s.id && ctx.refresh(), 500));
  return () => {
    clearInterval(timer);
    offs.forEach((off) => off());
    document.querySelector('.fullscreen-code')?.remove();
  };
}

async function pairSheet(d, ctx) {
  const { devices } = await api.get('/devices').catch(() => ({ devices: [] }));
  const readers = devices.filter((x) => ['nfc_reader', 'puck'].includes(x.kind));
  sheet({
    title: 'Link a student card',
    content: html`<div class="stack">
      <p class="muted small">After linking, the student can tap their card on a reader in this room to check in. Citrus stores only a keyed fingerprint of the card number.</p>
      <form class="form" id="pair-form">
        <label class="field"><span>Student</span><select class="select" name="user_id">${d.people.map((p) => html`<option value="${p.id}">${p.name}${p.has_card ? ' (already linked)' : ''}</option>`)}</select></label>
        ${readers.length ? html`<label class="field"><span>Reader</span><select class="select" name="device">${readers.map((r) => html`<option value="${r.id}" ${r.room === d.session.room ? 'selected' : ''}>${r.name}${r.room ? ` · ${r.room}` : ''}${r.online ? '' : ' (offline)'}</option>`)}</select><span class="hint">The next card tapped on this reader within 2 minutes is linked.</span></label>`
          : html`<label class="field"><span>Card number (UID)</span><input class="input mono" name="card_uid" placeholder="04A1B2C3D4" required><span class="hint">No reader is registered, so enter the UID printed by your USB reader.</span></label>`}
        <label class="check"><input type="checkbox" name="consent" required> The student agreed to link their card</label>
        <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">${readers.length ? 'Wait for tap' : 'Link card'}</button></div>
      </form>
    </div>`,
    onMount(el, close) {
      onSubmit($('#pair-form', el), async (v) => {
        if (readers.length) {
          await api.post(`/devices/${v.device}/pair`, { user_id: Number(v.user_id), consent: !!v.consent });
          close();
          toast('Ask the student to tap their card on the reader now', 'info', { duration: 6000 });
        } else {
          await api.post(`/participation/${d.session.id}/nfc/bind`, { user_id: Number(v.user_id), card_uid: v.card_uid, confirm_student_consent: !!v.consent });
          close();
          ctx.refresh();
          return 'Card linked';
        }
      });
    },
  });
}
