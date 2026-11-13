/**
 * More tools (/apps/gallery): tools people at your university made and shared. Add one to My tools with a tap.
 * Administrators also see the tools waiting for review and approve or decline them here.
 */
import { html, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { pageHead, empty } from '../core/components.js';
import { busy, prompt, toast, toastError } from '../core/ui.js';

function row(t, { admin = false, waiting = false } = {}) {
  return html`<div class="list-row">
    <span class="tile accent">${icon(t.icon || 'layers', 18)}</span>
    <a class="body" href="/apps/${t.id}" style="color:inherit;text-decoration:none"><span class="title">${t.name}</span><span class="sub">${t.description}</span><span class="sub">By ${t.maker || 'someone at your university'}${waiting ? '' : ` · added by ${t.users}`}</span></a>
    <span class="trail">${waiting ? html`<a class="btn btn-sm btn-ghost" href="/apps/${t.id}">Try it</a><button class="btn btn-sm btn-primary" data-review="${t.id}" data-decision="approve">Approve</button><button class="btn btn-sm btn-ghost" data-review="${t.id}" data-decision="reject">Decline</button>`
      : t.mine ? html`<span class="chip">Yours</span>` : t.added ? html`<button class="btn btn-sm btn-ghost" data-remove="${t.id}">Remove</button>` : html`<button class="btn btn-sm btn-primary" data-add="${t.id}">${icon('plus', 14)} Add</button>`}
      ${admin && !waiting ? html`<button class="btn btn-sm btn-ghost btn-icon" data-delete="${t.id}" aria-label="Remove from More tools">${icon('trash', 15)}</button>` : ''}</span>
  </div>`;
}

export default {
  title: 'More tools',
  async load() {
    return api.get('/apps/gallery');
  },
  render(d) {
    return html`${pageHead({ back: { href: '/apps', label: 'My tools' }, title: 'More tools', subtitle: 'Tools people at your university made with Campus and shared. Add the ones you like to My tools.' })}
      <div class="stack stagger" style="max-width:900px">
        ${d.admin && d.waiting.length ? html`<section class="card flush"><div class="card-head"><h2>Waiting for review</h2><span class="chip warning">${d.waiting.length}</span></div>
          <p class="small muted" style="padding:0 20px">Try each one first. Approve tools that are useful and fit the university’s rules; they then appear here for everyone.</p>
          <div class="list" style="padding-bottom:8px">${d.waiting.map((t) => row(t, { admin: true, waiting: true }))}</div></section>` : ''}
        <section class="card flush"><div class="card-head"><h2>Shared tools</h2><a class="btn btn-sm" href="/apps">${icon('sparkle', 14)} Make your own</a></div>
          ${d.tools.length ? html`<div class="list" style="padding-bottom:8px">${d.tools.map((t) => row(t, { admin: d.admin }))}</div>`
            : html`<div style="padding:0 20px 16px">${empty({ icon: 'layers', title: 'Nothing shared yet', body: 'When someone shares a tool and it is approved, it appears here.' })}</div>`}
        </section>
        <p class="small muted">Shared tools follow the university’s rules: no collecting personal data, nothing that helps cheat, nothing offensive. They run on their own and can’t see your account or reach the internet.</p>
      </div>`;
  },
  mount(root, d, ctx) {
    const offs = [
      on(root, 'click', '[data-add]', (e, b) => busy(b, () => api.post(`/apps/${b.dataset.add}/add`).then(() => {
        toast('Added to My tools', 'success', { duration: 1600 });
        ctx.refresh();
      }, toastError))),
      on(root, 'click', '[data-remove]', (e, b) => busy(b, () => api.del(`/apps/${b.dataset.remove}/add`).then(ctx.refresh, toastError))),
      on(root, 'click', '[data-review]', async (e, b) => {
        const decision = b.dataset.decision;
        const note = decision === 'reject' ? await prompt({ title: 'Decline this tool?', label: 'Tell the maker why (optional)', confirmLabel: 'Decline', minLength: 0 }) : '';
        if (note === null) return;
        busy(b, () => api.post(`/apps/${b.dataset.review}/review`, { decision, note: note || undefined }).then(ctx.refresh, toastError));
      }),
      on(root, 'click', '[data-delete]', (e, b) => busy(b, () => api.del(`/apps/${b.dataset.delete}`).then(ctx.refresh, toastError))),
    ];
    return () => offs.forEach((off) => off());
  },
};
