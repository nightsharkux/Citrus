import { html, $ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session } from '../core/store.js';
import { onSubmit, toastError } from '../core/ui.js';
import { enterApp } from '../shell.js';
import { ringMark } from '../core/brand.js';

export default {
  public: true,
  title: 'Sign in',
  layout: 'full',
  render(_, ctx) {
    const error = ctx.query.get('error');
    const ret = ctx.query.get('return') || '/home';
    const many = session.institutions.length > 1;
    return html`
      <div class="auth">
        <div class="card auth-card stagger">
          <span class="auth-mark">${ringMark(46)}</span>
          <h1>Welcome back</h1>
          <p class="subtitle">Sign in to pick up where you left off.</p>
          ${error ? html`<div class="notice danger" style="margin-bottom:16px">${icon('alert', 18)}<span>${error}</span></div>` : ''}
          ${session.sso.enabled ? html`
            <a class="btn btn-primary btn-lg btn-block" href="/auth/sso/start?return=${encodeURIComponent(ret)}" data-native>${icon('shield', 18)} Continue with ${session.sso.label}</a>
            <div class="divider">or use your Citrus password</div>` : ''}
          <form class="form" id="login-form">
            ${many ? html`<label class="field"><span>University</span><select class="select" name="institution_id">${session.institutions.map((i) => html`<option value="${i.id}">${i.name}</option>`)}</select></label>` : ''}
            <label class="field"><span>Email</span><input class="input" type="email" name="email" autocomplete="email" required autofocus placeholder="you@university.edu"></label>
            <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required minlength="1"></label>
            <button class="btn ${session.sso.enabled ? '' : 'btn-primary'} btn-lg btn-block">Sign in</button>
          </form>
          ${session.guests ? html`<button type="button" class="btn btn-block mt-16" id="guest-btn">Continue as guest</button>` : ''}
          ${session.registration ? html`<p class="center small muted mt-24">New here? <a href="/register${ctx.query.get('return') ? `?return=${encodeURIComponent(ret)}` : ''}">Create an account</a></p>` : ''}
        </div>
      </div>`;
  },
  mount(root, _, ctx) {
    $('#guest-btn', root)?.addEventListener('click', async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        await api.post('/guest');
        await enterApp(ctx.query.get('return') || '/home');
      } catch (error) {
        button.disabled = false;
        toastError(error);
      }
    });
    onSubmit($('#login-form', root), async (values) => {
      await api.post('/login', { ...values, institution_id: values.institution_id ? Number(values.institution_id) : undefined });
      await enterApp(ctx.query.get('return') || '/home');
    });
  },
};
