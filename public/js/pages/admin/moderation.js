/** Admin · Moderation: pending posts, reports and user feedback. */
import { html, render, $, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import { pageHead, segmented, empty, avatar } from '../../core/components.js';
import { ago, humanize, dateTime } from '../../core/format.js';
import { confirm, toast, toastError, busy } from '../../core/ui.js';
import { markdown } from '../../core/markdown.js';

const STATUS = [['new', 'New', ''], ['planned', 'Planned', 'info'], ['done', 'Done', 'success'], ['declined', 'Declined', 'danger']];

export default {
  title: 'Moderation',
  roles: ['admin'],
  async load(ctx) {
    const tab = ['reports', 'feedback'].includes(ctx.query.get('tab')) ? ctx.query.get('tab') : 'posts';
    const [mod, suggestions, ai] = await Promise.all([api.get('/connect/moderation'), api.get('/admin/suggestions'), api.get('/ai/settings')]);
    return { tab, ...mod, suggestions: suggestions.suggestions, aiEnabled: ai.aiEnabled };
  },
  render(d) {
    const tabs = [
      ['posts', `Posts${d.pending.length ? ` (${d.pending.length})` : ''}`, '/admin/moderation'],
      ['reports', `Reports${d.reports.length ? ` (${d.reports.length})` : ''}`, '/admin/moderation?tab=reports'],
      ['feedback', 'Feedback', '/admin/moderation?tab=feedback'],
    ];
    return html`${pageHead({ title: 'Moderation', subtitle: 'Keep the campus feed trustworthy and hear what people need.' })}
      <div class="page-tabs">${segmented(tabs, d.tab)}</div>
      <div class="stack stagger">${d.tab === 'reports' ? reports(d) : d.tab === 'feedback' ? feedback(d) : posts(d)}</div>`;
  },
  mount(root, d, ctx) {
    const offs = [
      on(root, 'click', '[data-moderate]', async (e, b) => {
        const action = b.dataset.action;
        if (action === 'publish' && b.dataset.official === '1' && !(await confirm({ title: 'Publish as verified?', message: 'This post claims to speak for the university or an organisation. Only publish if you have checked that claim.', confirmLabel: 'Publish as verified' }))) return;
        if (action === 'remove' && !(await confirm({ title: 'Remove this post?', message: 'It disappears from the feed for everyone.', confirmLabel: 'Remove', danger: true }))) return;
        await busy(b, () => api.post('/connect/moderation', { id: Number(b.dataset.moderate), action }).then(() => {
          toast({ publish: 'Published', reject: 'Rejected', remove: 'Removed', dismiss_reports: 'Reports dismissed' }[action], 'success');
          ctx.refresh();
        }, toastError));
      }),
      on(root, 'change', '[data-suggestion]', (e) => api.patch(`/admin/suggestions/${e.target.dataset.suggestion}`, { status: e.target.value }).then(() => toast('Updated', 'success'), toastError)),
      on(root, 'click', '[data-summarise]', (e, b) => busy(b, async () => {
        try {
          const r = await api.post('/admin/suggestions/summary');
          render($('#summary', root), html`<div class="prose small">${markdown(r.summary)}</div><p class="small faint mt-8">Based on ${r.count} open suggestions. AI-generated — verify before acting.</p>`);
        } catch (error) {
          toastError(error);
        }
      })),
    ];
    return () => offs.forEach((off) => off());
  },
};

function posts(d) {
  if (!d.pending.length) return html`<div class="card">${empty({ icon: 'check-circle', title: 'Nothing waiting', body: 'New posts from students land here before they go live.' })}</div>`;
  return d.pending.map((p) => html`<article class="card">
    <div class="spread"><div class="cluster" style="--gap:10px">${avatar(p.author, 'sm')}<span class="small"><strong>${p.author}</strong> · ${ago(p.created)}</span></div><span class="chip">${humanize(p.category)}</span></div>
    <h3 class="mt-16">${p.title}</h3>
    <p class="pre-wrap mt-8 muted">${p.body}</p>
    ${p.event_start || p.location ? html`<p class="small mt-8">${p.event_start ? `${dateTime(p.event_start)} ` : ''}${p.location ? `· ${p.location}` : ''}</p>` : ''}
    ${p.link ? html`<p class="small mt-8"><a href="${p.link}" target="_blank" rel="noopener noreferrer">${p.link}</a></p>` : ''}
    ${p.official ? html`<div class="notice warning mt-16">${icon('alert', 18)}<span>Claims to represent the university or an organisation. Verify before publishing — it will be marked as verified.</span></div>` : ''}
    <div class="form-actions mt-16"><button class="btn" data-moderate="${p.id}" data-action="reject">Reject</button><button class="btn btn-primary" data-moderate="${p.id}" data-action="publish" data-official="${p.official ? 1 : 0}">${icon('check', 16)} Publish</button></div>
  </article>`);
}

function reports(d) {
  if (!d.reports.length) return html`<div class="card">${empty({ icon: 'flag', title: 'No reports', body: 'When someone reports a post, it shows up here.' })}</div>`;
  return html`<section class="card flush"><div class="list" style="padding:8px 0">${d.reports.map((r) => html`<div class="list-row">
    <span class="tile danger">${icon('flag', 18)}</span>
    <span class="body"><span class="title">${r.title}</span><span class="sub wrap">“${r.reason}” · ${ago(r.created)}</span></span>
    <span class="trail"><a class="btn btn-sm btn-ghost" href="/campus?post=${r.post_id}">View</a><button class="btn btn-sm" data-moderate="${r.post_id}" data-action="dismiss_reports">Dismiss</button><button class="btn btn-sm btn-danger" data-moderate="${r.post_id}" data-action="remove">Remove</button></span>
  </div>`)}</div></section>`;
}

function feedback(d) {
  return html`
    <section class="card"><div class="spread"><div><h2>Themes</h2><p class="small muted">Group open suggestions into themes with AI.</p></div><button class="btn" data-summarise ${d.aiEnabled && d.suggestions.length > 1 ? '' : 'disabled'}>${icon('sparkle', 15)} Summarise</button></div><div id="summary" class="mt-16"></div></section>
    ${d.suggestions.length ? html`<section class="card flush"><div class="list" style="padding:8px 0">${d.suggestions.map((s) => html`<div class="list-row">
      ${avatar(s.name, 'sm')}
      <span class="body"><span class="title wrap" style="font-weight:500">${s.message}</span><span class="sub">${s.name} · ${ago(s.created)}</span></span>
      <span class="trail"><select class="select" data-suggestion="${s.id}" style="min-height:34px;height:34px;padding:4px 34px 4px 12px;font-size:13px;width:auto">${STATUS.map(([v, l]) => html`<option value="${v}" ${s.status === v ? 'selected' : ''}>${l}</option>`)}</select></span>
    </div>`)}</div></section>` : html`<div class="card">${empty({ icon: 'bulb', title: 'No feedback yet', body: 'Suggestions sent from Settings → Feedback appear here.' })}</div>`}`;
}
