/**
 * The Data Service and Privacy Agreement in the app.
 *
 *   agreementGate()          a full-screen page nobody can get past without accepting (or signing out, downloading
 *                            their data, or deleting their account). Resolves when accepted; resolves false when the
 *                            person signed out or deleted their account.
 *   readAgreement({ role })  the text in a sheet, to read (before registering, from Settings)
 *   askAgreement({ role })   the text in a sheet with "I agree": resolves true when they agree (guests)
 *
 * The text comes from the server (GET /api/agreement), written for the person's role, with their institution's own
 * details and retention filled in. Every acceptance is recorded with its version (POST /api/agreement/accept).
 */
import { html, render, $ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { markdown } from '../core/markdown.js';
import { session, setSession } from '../core/store.js';
import { sheet, toast, toastError } from '../core/ui.js';

const fetchText = (role) => api.get(`/agreement${role ? `?role=${encodeURIComponent(role)}` : ''}`);

/** The agreement in a sheet, to read. */
export async function readAgreement({ role } = {}) {
  let doc;
  try {
    doc = await fetchText(role);
  } catch (error) {
    toastError(error);
    return;
  }
  sheet({
    title: doc.title,
    wide: true,
    className: 'agreement-sheet',
    content: html`<p class="small muted">Version ${doc.version} · updated ${doc.updated}</p><article class="prose agreement-text">${markdown(doc.markdown)}</article>`,
    footer: html`<button class="btn btn-primary" data-close>Close</button>`,
  });
}

/** The agreement in a sheet with an "I agree" button: resolves true when they agree, false when they close it. */
export async function askAgreement({ role } = {}) {
  let doc;
  try {
    doc = await fetchText(role);
  } catch (error) {
    toastError(error);
    return false;
  }
  return new Promise((resolve) => {
    let agreed = false;
    sheet({
      title: doc.title,
      wide: true,
      className: 'agreement-sheet',
      content: html`<p class="small muted">Version ${doc.version} · updated ${doc.updated}</p><article class="prose agreement-text">${markdown(doc.markdown)}</article>
        <label class="agreement-check"><input type="checkbox" data-agree-box> <span>I have read and agree to the ${doc.title}.</span></label>`,
      footer: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-agree disabled>Agree and continue</button>`,
      onMount(root, close) {
        const box = $('[data-agree-box]', root);
        const go = $('[data-agree]', root);
        box.addEventListener('change', () => { go.disabled = !box.checked; });
        go.addEventListener('click', () => {
          agreed = true;
          close();
        });
      },
      onClose: () => resolve(agreed),
    });
  });
}

/** A line for Settings and the sign-up pages: who accepted what, when. */
export const acceptedLine = (accepted) => (accepted?.current
  ? `You accepted version ${accepted.version}${accepted.at ? ` on ${new Date(accepted.at).toLocaleDateString()}` : ''}.`
  : 'You have not accepted the current version yet.');

/**
 * The blocking page. Shown before the app when the person has not accepted the current version: at first sign-in,
 * after the text changed, and for an old account the first time it signs in. It offers only the ways out that the
 * law keeps open: accept, sign out, download your data, delete your account.
 */
export function agreementGate({ signOut } = {}) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'agreement-gate';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Data Service and Privacy Agreement');
    document.body.append(root);
    document.body.style.overflow = 'hidden';
    render(root, html`<div class="agreement-card"><p class="muted">Loading…</p></div>`);

    const finish = (value) => {
      root.remove();
      document.body.style.overflow = '';
      resolve(value);
    };

    fetchText().then((doc) => {
      const user = session.user;
      const own = user?.auth_provider === 'local' && user.role !== undefined;
      render(root, html`<div class="agreement-card">
        <header class="agreement-head">
          <h1>${doc.title}</h1>
          <p class="small muted">Version ${doc.version} · updated ${doc.updated}. ${doc.accepted?.version ? 'It has changed since you last accepted it, so please read it again.' : 'Please read it before you continue.'}</p>
        </header>
        <article class="prose agreement-text" tabindex="0" data-agreement-text>${markdown(doc.markdown)}</article>
        <footer class="agreement-foot">
          <label class="agreement-check"><input type="checkbox" data-agree-box> <span>I have read and agree to this agreement (version ${doc.version}).</span></label>
          <div class="agreement-actions">
            <button class="btn btn-primary btn-lg" data-agree disabled>${icon('check', 18)} Agree and continue</button>
            <button class="btn btn-ghost" data-decline>I do not agree: sign out</button>
          </div>
          <details class="agreement-leave"><summary class="small muted">Other choices</summary>
            <p class="small muted mt-8">You can always take your data with you or delete your account instead.</p>
            <div class="cluster mt-8"><a class="btn btn-sm" href="/api/me/export" download>${icon('download', 14)} Download my data</a></div>
            ${own ? html`<form class="form mt-12" data-delete>
              <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
              <label class="field"><span>Type DELETE to confirm</span><input class="input" name="confirm" pattern="DELETE" required autocomplete="off"></label>
              <button class="btn btn-danger btn-sm">Delete my account</button></form>` : ''}
          </details>
        </footer>
      </div>`);
      const box = $('[data-agree-box]', root);
      const go = $('[data-agree]', root);
      box.addEventListener('change', () => { go.disabled = !box.checked; });
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          await api.post('/agreement/accept', { version: doc.version, accept: true, via: 'prompt' });
          setSession({ agreement: { required: false, version: doc.version } });
          finish(true);
        } catch (error) {
          go.disabled = !box.checked;
          toastError(error);
        }
      });
      $('[data-decline]', root).addEventListener('click', async () => {
        await signOut?.();
        finish(false);
      });
      $('[data-delete]', root)?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.target));
        try {
          await api.post('/me/delete', data);
          toast('Your account was deleted', 'success');
          await signOut?.();
          finish(false);
        } catch (error) {
          toastError(error);
        }
      });
      $('[data-agreement-text]', root)?.focus({ preventScroll: true });
    }).catch((error) => {
      render(root, html`<div class="agreement-card"><p>${error.message}</p><button class="btn" data-retry>Try again</button></div>`);
      $('[data-retry]', root)?.addEventListener('click', () => location.reload());
    });
  });
}
