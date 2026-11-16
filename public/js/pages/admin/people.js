/** Admin · People: roles, publishing rights, lecturer requests. */
import { html, $, $$, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import { session } from '../../core/store.js';
import { pageHead, segmented, empty, avatar } from '../../core/components.js';
import { ago, humanize, date } from '../../core/format.js';
import { sheet, onSubmit, confirm, toast, toastError, busy } from '../../core/ui.js';

export default {
  title: 'People',
  roles: ['admin'],
  async load(ctx) {
    const tab = ctx.query.get('tab') === 'requests' ? 'requests' : 'people';
    const [users, apps] = await Promise.all([api.get('/admin/users'), api.get('/admin/lecturer-applications')]);
    return { tab, users: users.users, applications: apps.applications };
  },
  render(d) {
    const counts = { student: 0, lecturer: 0, admin: 0 };
    d.users.forEach((u) => (counts[u.role] += 1));
    return html`
      ${pageHead({ title: 'People', subtitle: `${d.users.length} accounts · ${counts.student} students · ${counts.lecturer} lecturers · ${counts.admin} administrators` })}
      <div class="page-tabs">${segmented([['people', 'Everyone', '/admin/people'], ['requests', `Lecturer requests${d.applications.length ? ` (${d.applications.length})` : ''}`, '/admin/people?tab=requests']], d.tab)}</div>
      ${d.tab === 'requests' ? requests(d) : people(d)}`;
  },
  mount(root, d, ctx) {
    const offs = [
      on(root, 'input', '[data-q]', () => filter(root)),
      on(root, 'click', '[data-role-filter]', (e, b) => {
        $$('[data-role-filter]', root).forEach((x) => x.classList.toggle('is-active', x === b));
        filter(root);
      }),
      on(root, 'click', '[data-person]', (e, b) => manage(d.users.find((u) => u.id === Number(b.dataset.person)), ctx)),
      on(root, 'click', '[data-decide]', async (e, b) => {
        const approve = b.dataset.decision === 'approve';
        if (approve && !(await confirm({ title: 'Approve lecturer access?', message: 'Only approve after verifying this person is a member of teaching staff.', confirmLabel: 'Approve' }))) return;
        await busy(b, () => api.post('/admin/lecturer-applications', { user_id: Number(b.dataset.decide), decision: b.dataset.decision }).then(() => {
          toast(approve ? 'Lecturer approved' : 'Request declined', 'success');
          ctx.refresh();
        }, toastError));
      }),
    ];
    return () => offs.forEach((off) => off());
  },
};

function filter(root) {
  const q = $('[data-q]', root).value.trim().toLowerCase();
  const role = $('[data-role-filter].is-active', root)?.dataset.roleFilter || 'all';
  $$('[data-person]', root).forEach((el) => el.classList.toggle('hidden', !(el.dataset.text.includes(q) && (role === 'all' || el.dataset.role === role))));
}

function people(d) {
  return html`<section class="card flush">
    <div class="card-head" style="flex-wrap:wrap">
      <div class="search-input" style="flex:1;min-width:200px;max-width:360px">${icon('search', 16)}<input class="input" data-q placeholder="Search name or email" style="height:38px;min-height:38px"></div>
      <div class="cluster" style="--gap:6px">${[['all', 'All'], ['student', 'Students'], ['lecturer', 'Lecturers'], ['admin', 'Admins']].map(([k, l], i) => html`<button class="chip ${i === 0 ? 'is-active' : ''}" data-role-filter="${k}">${l}</button>`)}</div>
    </div>
    <div class="list" style="padding-bottom:8px">${d.users.map((u) => html`<button class="list-row" data-person="${u.id}" data-role="${u.role}" data-text="${`${u.name} ${u.email}`.toLowerCase()}">
      ${avatar(u.name)}
      <span class="body"><span class="title">${u.name}${u.id === session.user.id ? ' (you)' : ''}</span><span class="sub">${u.email}${u.auth_provider === 'oidc' ? ' · university login' : ''}</span></span>
      <span class="trail">${u.can_publish ? html`<span class="chip info">Publisher</span>` : ''}${u.requested_role === 'lecturer' && u.role === 'student' ? html`<span class="chip warning">Requested lecturer</span>` : ''}<span class="chip ${u.role === 'admin' ? 'accent' : u.role === 'lecturer' ? 'success' : ''}">${humanize(u.role)}</span><span class="small hide-sm">${u.last_login ? ago(u.last_login) : 'Never'}</span>${icon('chevron-right', 16)}</span>
    </button>`)}</div>
  </section>`;
}

function requests(d) {
  if (!d.applications.length) return html`<div class="card">${empty({ icon: 'user-plus', title: 'No pending requests', body: 'When someone registers as a lecturer, they appear here for approval.' })}</div>`;
  return html`<div class="stack">${d.applications.map((a) => html`<section class="card spread" style="flex-wrap:wrap">
    <div class="cluster">${avatar(a.name, 'lg')}<div><h3>${a.name}</h3><p class="small muted">${a.email} · requested ${date(a.created)}</p></div></div>
    <div class="cluster"><button class="btn" data-decide="${a.id}" data-decision="reject">Decline</button><button class="btn btn-primary" data-decide="${a.id}" data-decision="approve">${icon('check', 16)} Approve</button></div>
  </section>`)}
  <p class="small faint">Verify staff identity outside Citrus (e.g. via HR or the faculty office) before approving.</p></div>`;
}

function manage(u, ctx) {
  const self = u.id === session.user.id;
  sheet({
    title: u.name,
    content: html`<form class="form" id="person-form">
      <p class="small muted">${u.email} · joined ${date(u.created)} · last active ${u.last_login ? ago(u.last_login) : 'never'}${u.has_card ? ' · card linked' : ''}</p>
      <label class="field"><span>Role</span><select class="select" name="role" ${self ? 'disabled' : ''}>${['student', 'lecturer', 'admin'].map((r) => html`<option value="${r}" ${u.role === r ? 'selected' : ''}>${humanize(r)}</option>`)}</select>${self ? html`<span class="hint">You can’t change your own role.</span>` : html`<span class="hint">Changing a role signs the person out so new permissions apply.</span>`}</label>
      <label class="spread"><span><strong>Can publish to the campus feed</strong><br><span class="small muted">Their posts skip moderation.</span></span><span class="switch"><input type="checkbox" name="can_publish" ${u.can_publish ? 'checked' : ''}><span></span></span></label>
      <div class="form-actions">
        ${self ? '' : html`<button type="button" class="btn btn-ghost" data-signout style="margin-right:auto">${icon('logout', 15)} Sign out everywhere</button>`}
        <button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Save</button>
      </div>
    </form>`,
    onMount(el, close) {
      onSubmit($('#person-form', el), async (v) => {
        await api.patch(`/admin/users/${u.id}`, { ...(self ? {} : { role: v.role }), can_publish: !!v.can_publish, unlock: true });
        close();
        ctx.refresh();
        return 'Saved';
      });
      el.querySelector('[data-signout]')?.addEventListener('click', async () => {
        await api.post(`/admin/users/${u.id}/sign-out`).catch(toastError);
        toast(`${u.name} was signed out`, 'success');
      });
    },
  });
}
