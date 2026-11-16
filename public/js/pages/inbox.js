/** Inbox: notifications and notification preferences (including browser push). */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { setSession } from '../core/store.js';
import { pageHead, segmented, empty } from '../core/components.js';
import { ago, dayKey } from '../core/format.js';
import { onSubmit, toast, toastError, busy } from '../core/ui.js';
import { push } from '../features/push.js';

const TABS = [['all', 'Notifications', '/inbox'], ['preferences', 'Preferences', '/inbox/preferences']];
const KIND = { system: ['bell', ''], campus: ['compass', 'info'], course: ['book', 'success'], device: ['nfc', 'warning'] };
const LEVELS = [['all', 'Everything'], ['personalized', 'My topics'], ['essential', 'Essential only'], ['digest', 'Digest']];
const TOPICS = { announcement: 'Announcements', event: 'Events', job: 'Jobs', housing: 'Housing', research: 'Research & theses', community: 'Community', product: 'App updates' };

export default {
  title: 'Inbox',
  async load(ctx) {
    const tab = ctx.params.tab || 'all';
    if (tab === 'preferences') {
      const [prefs, sub] = await Promise.all([api.get('/connect/preferences'), push.current().catch(() => null)]);
      return { tab, ...prefs, subscribed: !!sub };
    }
    return { tab: 'all', ...(await api.get('/notifications')) };
  },
  render(d) {
    return html`
      ${pageHead({ title: 'Inbox', actions: d.tab === 'all' && d.notifications.length ? html`<button class="btn" data-clear>${icon('trash', 16)} Clear read</button>` : '' })}
      <div class="page-tabs">${segmented(TABS, d.tab)}</div>
      ${d.tab === 'preferences' ? preferences(d) : list(d)}`;
  },
  mount(root, d, ctx) {
    if (d.tab === 'preferences') return mountPreferences(root, d, ctx);
    const offs = [
      on(root, 'click', '[data-clear]', async () => {
        await api.del('/notifications').catch(toastError);
        ctx.refresh();
      }),
      on(root, 'click', '[data-dismiss]', async (e, b) => {
        e.preventDefault();
        e.stopPropagation();
        b.closest('.list-row').remove();
        await api.del(`/notifications/${b.dataset.dismiss}`).catch(() => {});
      }),
    ];
    ctx.live.on('notification', () => ctx.refresh());
    if (d.unread) {
      api.post('/notifications/read', { all: true }).then(() => setSession({ unread: 0 })).catch(() => {});
    }
    return () => offs.forEach((off) => off());
  },
};

function list({ notifications }) {
  if (!notifications.length) return html`<div class="card">${empty({ icon: 'inbox', title: 'You’re all caught up', body: 'Approvals, new concept checks, schedule changes and campus updates will land here.' })}</div>`;
  const today = dayKey(new Date().toISOString());
  const groups = [['New', notifications.filter((n) => !n.read)], ['Today', notifications.filter((n) => n.read && dayKey(n.created) === today)], ['Earlier', notifications.filter((n) => n.read && dayKey(n.created) !== today)]];
  return html`<div class="stack stagger">${groups.filter(([, items]) => items.length).map(([label, items]) => html`<section>
    <h3 class="section-title">${label}</h3>
    <div class="card flush"><div class="list" style="padding:6px 0">${items.map((n) => {
      const [glyph, tone] = KIND[n.kind] || KIND.system;
      return html`<a class="list-row notification ${n.read ? '' : 'is-unread'}" href="${n.link || '/inbox'}">
        <span class="tile ${tone}">${icon(glyph, 18)}</span>
        <span class="body"><span class="title wrap">${n.title}</span>${n.body ? html`<span class="sub wrap">${n.body}</span>` : ''}</span>
        <span class="trail"><span class="small">${ago(n.created)}</span><button class="btn btn-ghost btn-icon btn-sm" data-dismiss="${n.id}" aria-label="Dismiss">${icon('x', 15)}</button></span>
      </a>`;
    })}</div></div>
  </section>`)}</div>`;
}

function preferences(d) {
  const p = d.preferences;
  return html`<div class="grid-2 stagger" style="align-items:start">
    <div class="stack">
      <section class="card">
        <div class="spread"><div><h2>Push notifications</h2><p class="small muted mt-8">${push.supported() ? 'Get alerts on this device even when Citrus is closed.' : 'This browser can’t receive push notifications here (HTTPS is required outside localhost).'}</p></div>
          <label class="switch"><input type="checkbox" id="push-toggle" ${d.subscribed ? 'checked' : ''} ${push.supported() ? '' : 'disabled'} aria-label="Push notifications"><span></span></label></div>
        ${d.subscribed ? html`<button class="btn btn-sm mt-16" data-test-push>${icon('bell', 15)} Send a test</button>` : ''}
      </section>
      <section class="card">
        <h2>Tell me in plain words</h2>
        <p class="small muted mt-8">Try “Notify me about student jobs”, “Mute events” or “Essential notifications only”.</p>
        <form class="input-row mt-16" id="command-form"><input class="input" name="text" required minlength="4" placeholder="Mute housing posts"><button class="btn btn-primary">Apply</button></form>
        <p class="small mt-8" id="command-reply" aria-live="polite"></p>
      </section>
    </div>
    <section class="card">
      <h2>What reaches you</h2>
      <form class="form mt-16" id="prefs-form">
        <div class="field"><span>Level</span><div class="choice-grid two">${LEVELS.map(([v, label]) => html`<label class="choice"><input type="radio" name="level" value="${v}" ${p.level === v ? 'checked' : ''}>${label}</label>`)}</div></div>
        <div class="field"><span>Campus topics</span><div class="cluster">${Object.entries(TOPICS).map(([v, label]) => html`<label class="chip-check"><input type="checkbox" name="topics" value="${v}" ${p.topics.includes(v) ? 'checked' : ''}><span>${label}</span></label>`)}</div></div>
        <div class="input-row">
          <label class="field"><span>Quiet from</span><input class="input" type="time" name="quiet_start" value="${p.quiet_start}"></label>
          <label class="field"><span>Until</span><input class="input" type="time" name="quiet_end" value="${p.quiet_end}"></label>
        </div>
        <p class="hint">During quiet hours, updates wait in your inbox instead of buzzing your phone. Course and approval notices always arrive in the inbox.</p>
        <div class="form-actions"><button class="btn btn-primary">Save preferences</button></div>
      </form>
    </section>
  </div>`;
}

function mountPreferences(root, d, ctx) {
  onSubmit($('#prefs-form', root), async (v) => {
    await api.patch('/connect/preferences', { level: v.level, topics: Array.isArray(v.topics) ? v.topics : [], quiet_start: v.quiet_start, quiet_end: v.quiet_end });
    return 'Preferences saved';
  });
  onSubmit($('#command-form', root), async (v, form) => {
    const r = await api.post('/connect/command', v);
    render($('#command-reply', root), r.recognized ? html`<span style="color:var(--success)">${icon('check', 14)} ${r.reply}</span>` : html`<span class="muted">${r.reply}</span>`);
    if (r.recognized) {
      form.reset();
      setTimeout(ctx.refresh, 1400);
    }
  });
  $('#push-toggle', root)?.addEventListener('change', async (e) => {
    const toggle = e.target;
    toggle.disabled = true;
    try {
      if (toggle.checked) {
        await push.enable();
        toast('Push notifications are on for this device', 'success');
      } else {
        await push.disable();
        toast('Push notifications are off for this device', 'info');
      }
      ctx.refresh();
    } catch (error) {
      toggle.checked = !toggle.checked;
      toastError(error);
    } finally {
      toggle.disabled = false;
    }
  });
  $('[data-test-push]', root)?.addEventListener('click', (e) => busy(e.currentTarget, () => api.post('/push/test').then(() => toast('Test sent', 'success'), toastError)));
}
