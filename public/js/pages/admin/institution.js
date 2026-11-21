/** Admin · Institution: identity, access, data retention, integrations and audit log. */
import { html, $, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import { setSession, session } from '../../core/store.js';
import { pageHead } from '../../core/components.js';
import { ago, humanize } from '../../core/format.js';
import { onSubmit, toast, toastError, copyText } from '../../core/ui.js';

export default {
  title: 'Institution',
  roles: ['admin'],
  async load() {
    const [settings, audit] = await Promise.all([api.get('/admin/settings'), api.get('/admin/audit?limit=60')]);
    return { ...settings, audit: audit.entries };
  },
  render(d) {
    const s = d.settings;
    const i = d.integrations;
    const status = (ok, label) => html`<span class="chip ${ok ? 'success' : ''}"><span class="dot"></span>${label}</span>`;
    return html`
      ${pageHead({ title: 'Institution', subtitle: 'University-wide settings, integrations and the audit trail.', actions: html`<a class="btn" href="/api/admin/export" download>${icon('download', 16)} Export all data</a>` })}
      <div class="grid-2 stagger" style="align-items:start">
        <div class="stack">
          <section class="card"><h2>Identity</h2>
            <form class="form mt-16" id="name-form"><label class="field"><span>University name</span><input class="input" name="name" value="${d.institution.name}" required minlength="3"></label><div class="form-actions"><button class="btn btn-primary">Save</button></div></form>
          </section>
          <section class="card"><h2>Access</h2>
            <div class="stack mt-16">
              <label class="spread"><span><strong>Lecturers need approval</strong><br><span class="small muted">New lecturer accounts wait until an administrator approves them. When off, anyone can register as a lecturer and make courses.</span></span><span class="switch"><input type="checkbox" data-setting="lecturerApproval" ${s.lecturerApproval ? 'checked' : ''}><span></span></span></label>
              <label class="spread"><span><strong>Open registration</strong><br><span class="small muted">Anyone can create a student account.</span></span><span class="switch"><input type="checkbox" data-setting="allowRegistration" ${s.allowRegistration ? 'checked' : ''}><span></span></span></label>
              <label class="spread"><span><strong>Require university login</strong><br><span class="small muted">${i.sso.configured ? 'Only administrators may still use passwords.' : 'Configure single sign-on first (OIDC_* in .env).'}</span></span><span class="switch"><input type="checkbox" data-setting="ssoOnly" ${s.ssoOnly ? 'checked' : ''} ${i.sso.configured ? '' : 'disabled'}><span></span></span></label>
            </div>
          </section>
          <section class="card"><h2>Legal details</h2>
            <p class="small muted mt-8">Shown in the Data Service and Privacy Agreement that every user accepts. Anything you leave empty is described in general words (your institution, its data-protection officer). Changing the agreement text itself means a new version, which everyone must accept again.</p>
            <form class="form mt-16" id="legal-form">
              <label class="field"><span>Controller: the institution's name and address</span><input class="input" name="legalController" maxlength="400" value="${s.legalController || ''}" placeholder="Example University, 1 Campus Road, 12345 Town"></label>
              <label class="field"><span>Data-protection officer: name and contact</span><input class="input" name="legalDpo" maxlength="400" value="${s.legalDpo || ''}" placeholder="Name, email, phone"></label>
              <label class="field"><span>Where people send questions and requests</span><input class="input" name="legalContact" maxlength="400" value="${s.legalContact || ''}" placeholder="privacy@example.edu"></label>
              <label class="field"><span>Supervisory authority</span><input class="input" name="legalAuthority" maxlength="400" value="${s.legalAuthority || ''}" placeholder="The data-protection authority competent for your institution"></label>
              <div class="form-actions"><button class="btn btn-primary">Save</button></div>
            </form>
          </section>
          <section class="card"><h2>Data retention</h2>
            <form class="form mt-16" id="retention-form">
              <label class="field"><span>Delete meeting recordings after</span><div class="input-row" style="align-items:center"><input class="input" type="number" name="days" min="0" max="3650" value="${s.recordingRetentionDays}" style="max-width:140px"><span class="muted">days (0 = keep until the owner deletes them)</span></div></label>
              <label class="field"><span>Delete lecture transcripts, kept audio and students’ flag notes after</span><div class="input-row" style="align-items:center"><input class="input" type="number" name="textDays" min="0" max="3650" value="${s.lectureTextRetentionDays ?? 365}" style="max-width:140px"><span class="muted">days (0 = keep; the results of a lecture stay)</span></div></label>
              <div class="form-actions"><button class="btn btn-primary">Save</button></div>
            </form>
          </section>
        </div>
        <div class="stack">
          <section class="card">
            <h2>Open on other devices</h2>
            ${d.network.urls.length
              ? html`<p class="small muted mt-8">Phones, tablets and laptops on the same Wi-Fi can open Citrus while this computer runs it:</p>
                  ${d.network.urls.map((u) => html`<div class="code-box mt-8"><span>${u}</span><button class="btn btn-sm" data-copy="${u}">${icon('copy', 14)} Copy</button></div>`)}`
              : html`<p class="small muted mt-8">Citrus currently accepts connections from this computer only. Set <code>HOST=0.0.0.0</code> in <code>.env</code> and restart to open it from phones on the same Wi-Fi.</p>`}
            <p class="small muted mt-16">${d.network.secure
              ? 'Served over HTTPS: voice, push notifications and app install work on every device.'
              : 'Over a Wi-Fi address, other devices get everything except the microphone, push notifications and app install — browsers only allow those over HTTPS. For a secure link that also works outside your network, run share-online.bat.'}</p>
          </section>
          <section class="card flush"><div class="card-head"><h2>Integrations</h2></div>
            <div class="list" style="padding-bottom:8px">
              <div class="list-row"><span class="tile">${icon('shield', 18)}</span><span class="body"><span class="title">Single sign-on</span><span class="sub">${i.sso.configured ? i.sso.issuer : 'Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET'}</span></span><span class="trail">${status(i.sso.configured, i.sso.configured ? 'Configured' : 'Not set up')}</span></div>
              <div class="list-row"><span class="tile info">${icon('book', 18)}</span><span class="body"><span class="title">Moodle</span><span class="sub">${i.moodle.configured ? i.moodle.url : 'Set MOODLE_URL'}</span></span><span class="trail">${status(i.moodle.configured, i.moodle.configured ? 'Configured' : 'Not set up')}</span></div>
              <div class="list-row"><span class="tile warning">${icon('bell', 18)}</span><span class="body"><span class="title">Push notifications</span><span class="sub">${i.push.subscribers} people subscribed · needs HTTPS outside localhost</span></span><span class="trail">${status(true, 'Ready')}</span></div>
              <div class="list-row"><span class="tile success">${icon('cpu', 18)}</span><span class="body"><span class="title">AI provider</span><span class="sub">${i.ai.aiEnabled ? `${i.ai.label} · ${i.ai.model}` : i.ai.description}</span></span><span class="trail">${status(i.ai.aiEnabled, i.ai.aiEnabled ? 'Active' : 'Off')}</span></div>
              <div class="list-row"><span class="tile neutral">${icon('mic', 18)}</span><span class="body"><span class="title">Audio transcription</span><span class="sub">Uploaded audio transcription is in development.</span></span><span class="trail">${status(i.transcription.configured, i.transcription.configured ? 'On' : 'Off')}</span></div>
            </div>
            <p class="small faint" style="padding:0 20px 18px">Public address: ${d.publicUrl}</p>
          </section>
          <section class="card flush"><div class="card-head"><h2>Audit log</h2></div>
            <div class="list audit" style="padding-bottom:8px">${d.audit.length ? d.audit.map((a) => html`<div class="list-row no-icon"><span class="body"><span class="title small">${humanize(a.action)}</span><span class="sub">${a.actor || 'System'}${a.detail ? ` · ${a.detail}` : ''}</span></span><span class="trail small">${ago(a.created)}</span></div>`) : html`<p class="small muted" style="padding:0 20px 18px">Nothing yet.</p>`}</div>
          </section>
        </div>
      </div>`;
  },
  mount(root, d, ctx) {
    onSubmit($('#name-form', root), async (v) => {
      await api.patch('/knowledge/settings', v);
      setSession({ user: { ...session.user, institution: v.name } });
      return 'Saved';
    });
    onSubmit($('#legal-form', root), async (v) => {
      await api.patch('/admin/settings', { legalController: v.legalController, legalDpo: v.legalDpo, legalContact: v.legalContact, legalAuthority: v.legalAuthority });
      ctx.refresh();
      return 'Legal details saved';
    });
    onSubmit($('#retention-form', root), async (v) => {
      await api.patch('/admin/settings', { recordingRetentionDays: Number(v.days), lectureTextRetentionDays: Number(v.textDays) });
      ctx.refresh();
      return 'Retention updated';
    });
    const offCopy = on(root, 'click', '[data-copy]', (e, b) => copyText(b.dataset.copy, 'Address copied'));
    const offSettings = on(root, 'change', '[data-setting]', async (e) => {
      const el = e.target;
      try {
        await api.patch('/admin/settings', { [el.dataset.setting]: el.checked });
        toast('Saved', 'success');
      } catch (error) {
        el.checked = !el.checked;
        toastError(error);
      }
    });
    return () => {
      offCopy();
      offSettings();
    };
  },
};
