import { html, $ } from '../core/dom.js';
import { api } from '../core/api.js';
import { session } from '../core/store.js';
import { onSubmit, toast } from '../core/ui.js';
import { enterApp } from '../shell.js';
import { ringMark } from '../core/brand.js';

export default {
  public: true,
  title: 'Create account',
  layout: 'full',
  render() {
    if (!session.registration) {
      return html`<div class="auth"><div class="card auth-card"><h1>Registration is closed</h1><p class="subtitle">Ask your university administrator for an account.</p><a class="btn btn-primary btn-block" href="/login">Back to sign in</a></div></div>`;
    }
    const many = session.institutions.length > 1;
    return html`
      <div class="auth">
        <div class="card auth-card stagger">
          <span class="auth-mark">${ringMark(46)}</span>
          <h1>Create your account</h1>
          <p class="subtitle">It takes less than a minute.</p>
          <form class="form" id="register-form">
            ${many ? html`<label class="field"><span>University</span><select class="select" name="institution_id">${session.institutions.map((i) => html`<option value="${i.id}">${i.name}</option>`)}</select></label>` : ''}
            <label class="field"><span>Full name</span><input class="input" name="name" autocomplete="name" required minlength="2" maxlength="80" autofocus></label>
            <label class="field"><span>University email</span><input class="input" type="email" name="email" autocomplete="email" required></label>
            <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="new-password" required minlength="12"><span class="hint">At least 12 characters. A short sentence works well.</span></label>
            <div class="field"><span>I’m joining as</span>
              <div class="segmented" role="radiogroup">
                <label class="choice-pill"><input type="radio" name="role" value="student" checked hidden><span>Student</span></label>
                <label class="choice-pill"><input type="radio" name="role" value="lecturer" hidden><span>Lecturer</span></label>
              </div>
              <span class="hint" id="role-hint">Lecturer access is confirmed by your administrator. You can use student features meanwhile.</span>
            </div>
            <button class="btn btn-primary btn-lg btn-block">Create account</button>
          </form>
          <p class="center small muted mt-24">Already have an account? <a href="/login">Sign in</a></p>
        </div>
      </div>`;
  },
  mount(root) {
    const form = $('#register-form', root);
    if (!form) return;
    onSubmit(form, async (values) => {
      await api.post('/register', { ...values, institution_id: values.institution_id ? Number(values.institution_id) : undefined });
      if (values.role === 'lecturer') toast('Lecturer access requested — an administrator will review it.', 'info', { duration: 5000 });
      await enterApp('/home');
    });
  },
};
