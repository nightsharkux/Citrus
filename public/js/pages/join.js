/**
 * Join a lecture: with the six-digit code on the lecturer's screen (/join, or /join/123456), or with the link behind
 * a lecture's QR code (/join/<token>, features/lecture-qr.js). Signed in, it joins at once. Signed out (a phone
 * camera opened the QR code), it shows the lecture and lets anyone in: as a guest without an account, with a name
 * if they like, or by signing in. Joining also joins the course, so a student needs nothing else.
 */
import { html, $ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { pageHead } from '../core/components.js';
import { api } from '../core/api.js';
import { session } from '../core/store.js';
import { onSubmit, toastError } from '../core/ui.js';
import { ringMark } from '../core/brand.js';
import { dayLabel, time } from '../core/format.js';
import { enterApp } from '../shell.js';
import { joinForm, mountJoinForm } from './live.js';
import { readAgreement } from '../features/agreement.js';

const codeOf = (param) => (/^[\d\s-]+$/.test(param) && param.replace(/\D/g, '').length === 6 ? param.replace(/\D/g, '') : '');
const tokenOf = (param) => (/^[A-Za-z0-9_-]{12}$/.test(param) ? param : '');
const spaced = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;

export default {
  public: true,
  title: 'Join a lecture',
  layout: (s) => (s.user ? '' : 'full'),
  async load(ctx) {
    const param = String(ctx.params.code || '').trim();
    const code = codeOf(param);
    const token = code ? '' : tokenOf(param);
    if (session.user) {
      // A code or QR link: join straight away. A wrong or old one falls back to the form.
      if (!code && !token) return { code: '', error: param ? 'This link does not open a lecture. Type the six-digit code from the screen.' : '' };
      try {
        const r = await api.post('/live/join', token ? { token } : { code });
        return { go: `/live/${r.course_id}` };
      } catch (error) {
        return { code, error: error.message };
      }
    }
    if (token) {
      try {
        return { signedOut: true, token, info: await api.get(`/live/links/${token}`) };
      } catch (error) {
        return { signedOut: true, token, error: error.message };
      }
    }
    return { signedOut: true, code, error: param && !code ? 'This link does not open a lecture. Type the six-digit code from the screen.' : '' };
  },
  render(d) {
    if (d.go) return html``;
    if (d.signedOut) return welcome(d);
    return html`${pageHead({ title: 'Join a lecture', subtitle: 'Type the six-digit code your lecturer shows on the screen.' })}
      <section class="card stack" style="max-width:520px">
        ${d.error ? html`<div class="notice warning">${d.error}</div>` : ''}
        ${joinForm({ code: d.code, autofocus: true })}
        <p class="small muted">You join the course as well, so the lecture and its recap appear in Lectures from now on.</p>
      </section>`;
  },
  mount(root, d, ctx) {
    if (d.go) {
      ctx.navigate(d.go, { replace: true });
      return undefined;
    }
    if (!d.signedOut) return mountJoinForm(root, ctx.navigate);
    $('#guest-join [data-read-agreement]', root)?.addEventListener('click', (e) => {
      e.preventDefault();
      readAgreement({ role: 'student' });
    });
    onSubmit($('#guest-join', root), async (values) => {
      await api.post('/guest', { name: values.name, agree: values.agree === true, ...(d.token ? { lecture: d.token } : {}) });
      await enterApp(location.pathname); // signed in now: this page joins the lecture
    });
    $('#code-form', root)?.addEventListener('submit', (e) => {
      e.preventDefault();
      const digits = e.currentTarget.code.value.replace(/\D/g, '');
      if (digits.length === 6) ctx.navigate(`/join/${digits}`);
      else toastError(new Error('The code has six digits'));
    });
    return undefined;
  },
};

/** "Live now", or when it starts and where. */
function whenChip(info) {
  if (info.live) return html`<span class="chip success"><span class="dot live"></span>Live now</span>`;
  const l = info.lecture;
  const when = [l.starts ? `${dayLabel(l.starts)} · ${time(l.starts)}` : 'Not started yet', l.room].filter(Boolean).join(' · ');
  return html`<span class="chip outline">${icon('clock', 13)} ${when}</span>`;
}

/** For someone who scanned the QR code without being signed in: the lecture, and the ways in. */
function welcome(d) {
  const back = encodeURIComponent(location.pathname);
  const info = d.info;
  const ready = !d.error && (info || d.code);
  const title = info ? info.lecture.title : 'Join a lecture';
  const subtitle = info ? `${info.course.code} · ${info.course.title}` : d.code ? html`Lecture code <b class="mono">${spaced(d.code)}</b>` : 'Type the six-digit code from the screen.';
  return html`<div class="auth"><div class="card auth-card stagger join-welcome">
    <span class="auth-mark">${ringMark(46)}</span>
    <h1>${title}</h1>
    <p class="subtitle">${subtitle}</p>
    ${info && !d.error ? html`<p class="join-when">${whenChip(info)}</p>` : ''}
    ${d.error ? html`<div class="notice warning" style="margin-bottom:16px">${icon('alert', 18)}<span>${d.error}</span></div>` : ''}
    ${!ready && !d.token ? html`<form class="form" id="code-form">
        <label class="field"><span>Code from the screen</span><input class="input join-code-input" name="code" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="123 456" required autofocus></label>
        <button class="btn btn-primary btn-lg btn-block">${icon('arrow-right', 18)} Continue</button>
      </form><div class="divider">or</div>` : ''}
    ${ready && session.guests ? html`<form class="form" id="guest-join">
        <label class="field"><span>Your name <span class="faint">(optional)</span></span><input class="input" name="name" maxlength="60" autocomplete="name" placeholder="e.g. Lena Meyer" autofocus></label>
        <label class="agreement-check"><input type="checkbox" name="agree" required> <span><a href="#" data-read-agreement>Data Service and Privacy Agreement</a>: I have read it and agree.</span></label>
        <button class="btn btn-primary btn-lg btn-block">${icon('arrow-right', 18)} Join as guest</button>
        <p class="small muted">No account or app needed. In the lecture you decide whether your lecturer sees your name.</p>
      </form><div class="divider">or sign in</div>` : ''}
    <a class="btn btn-lg btn-block ${ready && session.guests ? '' : 'btn-primary'}" href="/login?return=${back}">Sign in</a>
    ${session.registration ? html`<p class="center small muted mt-24">New here? <a href="/register?return=${back}">Create an account</a></p>` : ''}
  </div></div>`;
}
