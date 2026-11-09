/** Study groups: what you are looking for, and who else is looking. The assistant uses the same requests. */
import { html, on, formValues } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { pageHead, empty, avatar } from '../core/components.js';
import { ago } from '../core/format.js';
import { toast, toastError } from '../core/ui.js';

function request(r) {
  const who = r.mine ? 'You' : r.name || 'A student';
  return html`<div class="list-row">
    ${avatar(r.name || '?')}
    <span class="body">
      <span class="title">${r.subject}${r.course ? html` <span class="chip">${r.course}</span>` : ''}</span>
      <span class="sub">${who}${!r.mine && r.programme ? ` · ${r.programme}` : ''} · ${ago(r.created)}${r.note ? ` · ${r.note}` : ''}</span>
      ${!r.mine ? (r.email ? html`<span class="sub"><a href="mailto:${r.email}">${r.email}</a></span>` : html`<span class="sub faint">Contact not shared</span>`) : ''}
    </span>
    <span class="trail">${r.mine ? html`
      <button class="btn btn-sm btn-ghost" data-share="${r.id}" data-on="${r.shareContact ? '0' : '1'}">${r.shareContact ? 'Stop sharing contact' : 'Share my contact'}</button>
      <button class="btn btn-sm btn-ghost" data-close="${r.id}">${icon('x', 14)} Close</button>` : ''}</span>
  </div>`;
}

export default {
  title: 'Study groups',
  load: () => api.get('/groups'),
  render(d) {
    return html`${pageHead({ title: 'Study groups', subtitle: 'Say what you want a group for. Students looking for the same are matched, and you can ask the assistant too.' })}
      <div class="stack">
        <section class="card">
          <h2>Find a group</h2>
          <form class="stack mt-16" id="seek" style="--gap:12px">
            <input class="input" name="subject" required minlength="2" maxlength="120" placeholder="Subject or course, e.g. Mathe 2">
            <input class="input" name="note" maxlength="300" placeholder="Note (optional): when, where, level">
            <label class="cluster small"><input type="checkbox" name="share_contact"> Share my name and e-mail with students who match</label>
            <div><button class="btn btn-primary">${icon('users', 16)} Look for a group</button></div>
          </form>
        </section>
        <section class="card">
          <h2>Your requests</h2>
          <div class="mt-16">${d.mine.length ? d.mine.map(request) : html`<p class="muted small">None open.</p>`}</div>
        </section>
        <section class="card">
          <h2>Students looking for a group</h2>
          <div class="mt-16">${d.others.length ? d.others.map(request) : empty({ icon: 'users', title: 'Nobody yet', body: 'Requests from other students appear here.' })}</div>
        </section>
      </div>`;
  },
  mount(root, d, ctx) {
    const offs = [
      on(root, 'submit', '#seek', async (e, form) => {
        e.preventDefault();
        const v = formValues(form);
        try {
          const r = await api.post('/groups', { subject: v.subject, note: v.note, share_contact: form.share_contact.checked });
          toast(r.matches.length ? `${r.matches.length} matching ${r.matches.length === 1 ? 'request' : 'requests'}` : 'Saved. You will be told when someone matches.', 'success');
          ctx.refresh();
        } catch (error) {
          toastError(error);
        }
      }),
      on(root, 'click', '[data-share]', async (e, b) => {
        try {
          await api.patch(`/groups/${b.dataset.share}`, { share_contact: b.dataset.on === '1' });
          ctx.refresh();
        } catch (error) {
          toastError(error);
        }
      }),
      on(root, 'click', '[data-close]', async (e, b) => {
        try {
          await api.del(`/groups/${b.dataset.close}`);
          ctx.refresh();
        } catch (error) {
          toastError(error);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  },
};
