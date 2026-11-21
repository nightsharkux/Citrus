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
import { getLanguage } from '../core/i18n.js';

/** The agreement in a language: the person's own, German first (it is the binding text). */
const fetchText = (role, lang) => api.get(`/agreement?lang=${lang === 'en' ? 'en' : 'de'}${role ? `&role=${encodeURIComponent(role)}` : ''}`);
const startLanguage = () => (getLanguage() === 'en' ? 'en' : 'de');

/** A Deutsch | English switch over the text; `show(doc)` draws a text into `box`. Re-reads the text in the other language. */
function languageSwitch(role, current, box, onDoc) {
  const wrap = document.createElement('div');
  wrap.className = 'agreement-lang';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Language of the agreement');
  wrap.dataset.noTranslate = '';
  let lang = current;
  const buttons = [['de', 'Deutsch'], ['en', 'English']].map(([code, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'agreement-lang-btn';
    b.textContent = label;
    b.lang = code;
    b.setAttribute('aria-pressed', String(code === lang));
    b.addEventListener('click', async () => {
      if (code === lang) return;
      try {
        const doc = await fetchText(role, code);
        lang = code;
        buttons.forEach((x) => x.setAttribute('aria-pressed', String(x.lang === lang)));
        onDoc(doc);
        box.scrollTop = 0;
      } catch (error) {
        toastError(error);
      }
    });
    wrap.append(b);
    return b;
  });
  return wrap;
}

/** The agreement in a sheet, to read. */
export async function readAgreement({ role } = {}) {
  let doc;
  try {
    doc = await fetchText(role, startLanguage());
  } catch (error) {
    toastError(error);
    return;
  }
  sheet({
    title: doc.title,
    wide: true,
    className: 'agreement-sheet',
    content: html`<div data-lang-slot></div><p class="small muted" data-version>Version ${doc.version} · ${doc.updated}</p><article class="prose agreement-text" lang="${doc.language}">${markdown(doc.markdown)}</article>`,
    footer: html`<button class="btn btn-primary" data-close>Close</button>`,
    onMount(root) {
      const article = $('.agreement-text', root);
      $('[data-lang-slot]', root).replaceWith(languageSwitch(role, doc.language, article, (next) => { render(article, markdown(next.markdown)); article.lang = next.language; }));
    },
  });
}

/** The agreement in a sheet with an "I agree" button: resolves true when they agree, false when they close it. */
export async function askAgreement({ role } = {}) {
  let doc;
  try {
    doc = await fetchText(role, startLanguage());
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
      content: html`<div data-lang-slot></div><p class="small muted">Version ${doc.version} · updated ${doc.updated}</p><article class="prose agreement-text" lang="${doc.language}">${markdown(doc.markdown)}</article>
        <label class="agreement-check"><input type="checkbox" data-agree-box> <span>I have read and agree to the Data Service and Privacy Agreement.</span></label>`,
      footer: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-agree disabled>Agree and continue</button>`,
      onMount(root, close) {
        const box = $('[data-agree-box]', root);
        const go = $('[data-agree]', root);
        const article = $('.agreement-text', root);
        $('[data-lang-slot]', root).replaceWith(languageSwitch(role, doc.language, article, (next) => { render(article, markdown(next.markdown)); article.lang = next.language; }));
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

    fetchText(undefined, startLanguage()).then((doc) => {
      const user = session.user;
      const own = user?.auth_provider === 'local' && user.role !== undefined;
      render(root, html`<div class="agreement-card">
        <header class="agreement-head">
          <h1>${doc.title}</h1>
          <p class="small muted">Version ${doc.version} · updated ${doc.updated}. ${doc.accepted?.version ? 'It has changed since you last accepted it, so please read it again.' : 'Please read it before you continue.'}</p>
        </header>
        <div class="agreement-lang-row" data-lang-slot></div>
        <article class="prose agreement-text" tabindex="0" data-agreement-text lang="${doc.language}">${markdown(doc.markdown)}</article>
        <footer class="agreement-foot">
          <label class="agreement-check"><input type="checkbox" data-agree-box> <span>I have read and agree to this agreement.</span></label>
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
      const article = $('[data-agreement-text]', root);
      $('[data-lang-slot]', root).replaceWith(languageSwitch(undefined, doc.language, article, (next) => { render(article, markdown(next.markdown)); article.lang = next.language; }));
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
