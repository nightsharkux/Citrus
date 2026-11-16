/** Admin · Devices: register, monitor and revoke classroom hardware. */
import { html, render, $, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import { pageHead, empty } from '../../core/components.js';
import { ago, humanize } from '../../core/format.js';
import { sheet, onSubmit, confirm, toast, toastError, copyText, busy } from '../../core/ui.js';
import { debounce } from '../../core/live.js';

const KIND = {
  puck: ['radio', 'Voice puck', 'Card reader + microphone + speaker. Starts sessions and answers spoken questions.'],
  nfc_reader: ['nfc', 'Card reader', 'Tap-to-confirm sign-in for lecturers; check-in for students.'],
  door_light: ['bulb', 'Door light', 'Shows the room status in colour.'],
  display: ['monitor', 'Display', 'Shows room status and messages.'],
};

export default {
  title: 'Devices',
  roles: ['admin'],
  layout: 'wide',
  async load() {
    return api.get('/devices');
  },
  render(d) {
    const active = d.devices.filter((x) => x.status === 'active');
    const revoked = d.devices.filter((x) => x.status !== 'active');
    return html`
      ${pageHead({ title: 'Devices', subtitle: 'Classroom hardware talks to Citrus over a signed API. A card tap never signs anyone in on its own — the person confirms in the app.', actions: html`<button class="btn btn-primary" data-register>${icon('plus', 17)} Register device</button>` })}
      <div class="stack stagger">
        ${active.length ? html`<div class="grid-auto" style="--min:280px">${active.map((x) => {
          const [glyph, label] = KIND[x.kind] || KIND.display;
          return html`<button class="card device-card" data-device="${x.id}">
            <div class="spread"><span class="tile ${x.online ? 'success' : 'neutral'}">${icon(glyph, 20)}</span><span class="chip ${x.online ? 'success' : ''}"><span class="dot ${x.online ? 'live' : ''}"></span>${x.online ? 'Online' : 'Offline'}</span></div>
            <h3 class="mt-16">${x.name}</h3>
            <p class="small muted">${label}${x.room ? ` · ${x.room}` : ' · no room'}</p>
            <p class="small faint mt-8"><span class="mono">${x.key}</span> · ${x.lastSeen ? `seen ${ago(x.lastSeen)}` : 'never connected'}${x.firmware ? ` · ${x.firmware}` : ''}</p>
          </button>`;
        })}</div>` : html`<div class="card">${empty({ icon: 'radio', title: 'No devices yet', body: 'Register a reader, puck or door light to get its credentials. No hardware yet? hardware/simulator.js runs the whole flow from a terminal — see docs/HARDWARE.md.', action: html`<button class="btn btn-primary" data-register>Register a device</button>` })}</div>`}
        ${revoked.length ? html`<section class="card flush"><div class="card-head"><h2>Revoked</h2></div><div class="list" style="padding-bottom:8px">${revoked.map((x) => html`<div class="list-row"><span class="tile neutral">${icon((KIND[x.kind] || KIND.display)[0], 18)}</span><span class="body"><span class="title">${x.name}</span><span class="sub">${x.key} · ${x.room || 'no room'}</span></span></div>`)}</div></section>` : ''}
      </div>`;
  },
  mount(root, d, ctx) {
    const offs = [
      on(root, 'click', '[data-register]', () => registerSheet(ctx)),
      on(root, 'click', '[data-device]', (e, b) => detailSheet(d.devices.find((x) => x.id === Number(b.dataset.device)), ctx)),
    ];
    const timer = setInterval(() => ctx.refresh(), 30_000);
    ctx.live.on('room.updated', debounce(ctx.refresh, 500));
    return () => {
      clearInterval(timer);
      offs.forEach((off) => off());
    };
  },
};

function credentialsView(creds) {
  const url = location.origin;
  const sim = `node hardware/simulator.js --url ${url} --id ${creds.deviceId} --secret ${creds.secret}`;
  return html`<div class="stack">
    <div class="notice warning">${icon('key', 18)}<span>Copy the secret now — it won’t be shown again. Store it only on the device.</span></div>
    <div class="field"><span>Device ID</span><div class="code-box"><span>${creds.deviceId}</span><button class="btn btn-sm" data-copy="${creds.deviceId}">${icon('copy', 14)}</button></div></div>
    <div class="field"><span>Secret</span><div class="code-box"><span>${creds.secret}</span><button class="btn btn-sm" data-copy="${creds.secret}">${icon('copy', 14)}</button></div></div>
    <div class="field"><span>Try it with the simulator</span><div class="code-box"><span>${sim}</span><button class="btn btn-sm" data-copy="${sim}">${icon('copy', 14)}</button></div></div>
  </div>`;
}

function wireCopies(el) {
  el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy)));
}

function registerSheet(ctx) {
  sheet({
    title: 'Register a device',
    content: html`<form class="form" id="device-form">
      <label class="field"><span>Name</span><input class="input" name="name" required minlength="2" placeholder="MF2 lectern puck" autofocus></label>
      <div class="field"><span>Type</span><div class="choice-grid two">${Object.entries(KIND).map(([k, [glyph, label, desc]], i) => html`<label class="choice" style="align-items:flex-start"><input type="radio" name="kind" value="${k}" ${i === 0 ? 'checked' : ''}><span class="tile sm">${icon(glyph, 16)}</span><span><strong style="display:block">${label}</strong><span class="small muted">${desc}</span></span></label>`)}</div></div>
      <label class="field"><span>Room</span><input class="input" name="room" placeholder="MF2"><span class="hint">Devices follow the status of their room and check students into sessions held there.</span></label>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Register</button></div>
    </form>`,
    onMount(el) {
      onSubmit($('#device-form', el), async (v) => {
        const r = await api.post('/devices', v);
        render($('.sheet-body', el), html`${credentialsView(r.credentials)}<div class="form-actions mt-24"><button class="btn btn-primary" data-close>Done</button></div>`);
        wireCopies(el);
        el.querySelector('[data-close]').addEventListener('click', () => ctx.refresh());
      });
    },
  });
}

async function detailSheet(device, ctx) {
  const log = await api.get(`/devices/${device.id}/events`).catch(() => ({ events: [], commands: [] }));
  const [glyph, label] = KIND[device.kind] || KIND.display;
  sheet({
    title: device.name,
    wide: true,
    content: html`<div class="stack">
      <div class="cluster"><span class="tile">${icon(glyph, 18)}</span><span class="small muted">${label} · <span class="mono">${device.key}</span> · ${device.status === 'active' ? (device.online ? 'online' : 'offline') : 'revoked'}${device.capabilities?.length ? ` · ${device.capabilities.join(', ')}` : ''}</span></div>
      ${device.status === 'active' ? html`<form class="input-row" id="rename-form"><input class="input" name="name" value="${device.name}" required minlength="2"><input class="input" name="room" value="${device.room}" placeholder="Room"><button class="btn">Save</button></form>
      <form class="input-row" id="message-form"><input class="input" name="text" placeholder="Send a test message to the device" maxlength="200"><button class="btn">${icon('send', 15)} Send</button></form>` : ''}
      <div class="grid-2">
        <div><h4 class="section-title">Recent events</h4>${log.events.length ? html`<div class="list">${log.events.slice(0, 12).map((e) => html`<div class="list-row no-icon" style="padding:8px 0"><span class="body"><span class="title small">${humanize(e.type.replace(/\./g, ' '))}</span><span class="sub">${e.summary || '—'}</span></span><span class="trail small">${ago(e.created)}</span></div>`)}</div>` : html`<p class="small muted">No events yet.</p>`}</div>
        <div><h4 class="section-title">Commands</h4>${log.commands.length ? html`<div class="list">${log.commands.slice(0, 12).map((c) => html`<div class="list-row no-icon" style="padding:8px 0"><span class="body"><span class="title small mono">${c.type}</span><span class="sub">${ago(c.created)}</span></span><span class="trail"><span class="chip ${c.status === 'acked' ? 'success' : c.status === 'expired' ? 'danger' : ''}">${c.status}</span></span></div>`)}</div>` : html`<p class="small muted">No commands yet.</p>`}</div>
      </div>
      <div id="creds"></div>
    </div>`,
    footer: device.status === 'active' ? html`<button class="btn btn-danger" data-revoke style="margin-right:auto">Revoke</button><button class="btn" data-rotate>${icon('key', 15)} New secret</button><button class="btn btn-primary" data-close>Done</button>` : html`<button class="btn btn-primary" data-close>Close</button>`,
    onMount(el, close) {
      onSubmit($('#rename-form', el), async (v) => {
        await api.patch(`/devices/${device.id}`, v);
        ctx.refresh();
        return 'Saved';
      });
      onSubmit($('#message-form', el), async (v, form) => {
        await api.post(`/devices/${device.id}/commands`, { type: 'display.message', text: v.text });
        form.reset();
        return 'Queued — the device receives it on its next heartbeat';
      });
      el.querySelector('[data-rotate]')?.addEventListener('click', async (e) => {
        if (!(await confirm({ title: 'Create a new secret?', message: 'The device stops working until you install the new secret on it.', confirmLabel: 'Create new secret' }))) return;
        await busy(e.target, async () => {
          const r = await api.post(`/devices/${device.id}/rotate`);
          render($('#creds', el), credentialsView(r.credentials));
          wireCopies(el);
        });
      });
      el.querySelector('[data-revoke]')?.addEventListener('click', async () => {
        if (!(await confirm({ title: `Revoke ${device.name}?`, message: 'It is disconnected immediately and can’t be re-enabled. Register it again to reuse the hardware.', confirmLabel: 'Revoke', danger: true }))) return;
        await api.del(`/devices/${device.id}`).catch(toastError);
        toast('Device revoked', 'success');
        close();
        ctx.refresh();
      });
    },
  });
}
