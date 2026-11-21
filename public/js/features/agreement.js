/**
 * Terms of Use and Privacy in the app: a plain document page like the legal pages of a website, in the person's
 * own version (student, guest, lecturer, administrator), with the four sections (terms of use, privacy policy,
 * cookie policy, retention) as tabs. It always opens in German, the binding text, with English as the second choice.
 *
 *   agreementGate({ signOut })  a page nobody gets past without accepting (or signing out, downloading their data,
 *                               or deleting their account). Resolves true when accepted, false when they left.
 *   askAgreement({ role })      the same page for guests joining a lecture: resolves true when they agree.
 *   readAgreement({ role })     to read only (before registering, from Settings), with a Close button.
 *
 * Everything on the page, buttons and labels included, is in the language of the text being shown, not the
 * interface language: switching Deutsch | English changes all of it. The text comes from the server
 * (GET /api/agreement); every acceptance is recorded with its version (POST /api/agreement/accept).
 */
import { html, render, $ } from '../core/dom.js';
import { api } from '../core/api.js';
import { markdown } from '../core/markdown.js';
import { session, setSession } from '../core/store.js';
import { toast, toastError } from '../core/ui.js';

/** Every word on the page, in both languages (it does not go through the interface translation). */
const WORDS = {
  de: {
    language: 'Sprache', appliesTo: 'Gilt für', version: 'Version', asOf: 'Stand', summary: 'Das Wichtigste in Kürze',
    first: 'Bitte lesen Sie die folgenden Bedingungen, bevor Sie Citrus nutzen.',
    changed: 'Die Bedingungen haben sich seit Ihrer letzten Zustimmung geändert. Bitte lesen Sie sie erneut.',
    check: 'Ich habe die Nutzungsbedingungen, die Datenschutzerklärung, die Cookie-Richtlinie und die Aufbewahrungsfristen gelesen und stimme zu.',
    agree: 'Zustimmen', decline: 'Ablehnen', close: 'Schließen', other: 'Weitere Möglichkeiten',
    otherText: 'Statt zuzustimmen können Sie Ihre Daten mitnehmen oder Ihr Konto löschen.',
    download: 'Meine Daten herunterladen', deleteAccount: 'Konto löschen', password: 'Passwort',
    typeDelete: 'Zur Bestätigung DELETE eingeben', deleted: 'Ihr Konto wurde gelöscht.', loading: 'Wird geladen …', retry: 'Erneut versuchen',
    docs: 'Rechtliche Texte',
  },
  en: {
    language: 'Language', appliesTo: 'Applies to', version: 'Version', asOf: 'As of', summary: 'The short version',
    first: 'Please read the following terms before you use Citrus.',
    changed: 'The terms have changed since you last accepted them. Please read them again.',
    check: 'I have read the terms of use, the privacy policy, the cookie policy and the retention periods, and I agree.',
    agree: 'Agree', decline: 'Decline', close: 'Close', other: 'Other options',
    otherText: 'Instead of agreeing you can take your data with you or delete your account.',
    download: 'Download my data', deleteAccount: 'Delete account', password: 'Password',
    typeDelete: 'Type DELETE to confirm', deleted: 'Your account was deleted.', loading: 'Loading …', retry: 'Try again',
    docs: 'Legal texts',
  },
};

const fetchDoc = (role, lang) => api.get(`/agreement?lang=${lang === 'en' ? 'en' : 'de'}${role ? `&role=${encodeURIComponent(role)}` : ''}`);
const dateOf = (iso, lang) => {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
};

/**
 * Open the page. `mode`: 'gate' (must accept; leaving = signOut), 'ask' (accept or decline), 'read' (close only).
 * Resolves with what the person did: true (agreed), false (declined, signed out, deleted), or null (closed).
 */
function open({ mode, role = null, signOut = null }) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'legal-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('data-no-translate', '');
    document.body.append(root);
    document.body.style.overflow = 'hidden';

    const st = { lang: 'de', doc: null, tab: 'terms', checked: false, busy: false, failed: null };
    const onKey = (e) => {
      if (e.key === 'Escape' && mode !== 'gate') done(mode === 'ask' ? false : null);
    };
    function done(value) {
      document.removeEventListener('keydown', onKey);
      root.remove();
      document.body.style.overflow = '';
      resolve(value);
    }
    document.addEventListener('keydown', onKey);

    async function load(lang) {
      st.failed = null;
      try {
        st.doc = await fetchDoc(role, lang);
        st.lang = st.doc.language;
        if (!st.doc.sections.some((s) => s.id === st.tab)) st.tab = st.doc.sections[0].id;
      } catch (error) {
        st.failed = error.message;
      }
      paint();
    }

    function paint() {
      const t = WORDS[st.lang];
      const { doc } = st;
      if (!doc) {
        render(root, html`<div class="legal"><main class="legal-main"><p class="legal-meta">${st.failed || t.loading}</p>${st.failed ? html`<button type="button" class="legal-btn" data-retry>${t.retry}</button>` : ''}</main></div>`);
        return;
      }
      const tab = doc.sections.find((s) => s.id === st.tab) || doc.sections[0];
      const intro = mode === 'gate' && doc.accepted?.version ? t.changed : mode === 'read' ? '' : t.first;
      const own = session.user?.auth_provider === 'local';
      render(root, html`<div class="legal" lang="${st.lang}">
        <header class="legal-top">
          <span class="legal-brand">Citrus</span>
          <div class="legal-lang" role="group" aria-label="${t.language}">
            <button type="button" class="legal-lang-btn" data-lang="de" lang="de" aria-pressed="${st.lang === 'de'}">Deutsch</button>
            <button type="button" class="legal-lang-btn" data-lang="en" lang="en" aria-pressed="${st.lang === 'en'}">English</button>
          </div>
          ${mode === 'read' ? html`<button type="button" class="legal-close" data-close>${t.close}</button>` : ''}
        </header>
        <main class="legal-main">
          <h1>${doc.title}</h1>
          <p class="legal-meta">${t.appliesTo}: ${doc.roleLabel} · ${t.version} ${doc.version} · ${t.asOf} ${dateOf(doc.updated, st.lang)}</p>
          ${intro ? html`<p class="legal-intro">${intro}</p>` : ''}
          <section class="legal-summary" aria-label="${t.summary}">
            <h2>${t.summary}</h2>
            <ul>${doc.summary.map((line) => html`<li>${line}</li>`)}</ul>
          </section>
          <nav class="legal-tabs" role="tablist" aria-label="${t.docs}">
            ${doc.sections.map((s) => html`<button type="button" role="tab" class="legal-tab" data-tab="${s.id}" aria-selected="${s.id === tab.id}">${s.title}</button>`)}
          </nav>
          <article class="legal-body prose" role="tabpanel" tabindex="0" data-body>${markdown(tab.markdown)}</article>
        </main>
        ${mode === 'read' ? '' : html`<footer class="legal-bar">
          <label class="legal-check"><input type="checkbox" data-check ${st.checked ? 'checked' : ''}> <span>${t.check}</span></label>
          <div class="legal-actions">
            <button type="button" class="legal-btn" data-decline>${t.decline}</button>
            <button type="button" class="legal-btn legal-btn-primary" data-agree ${st.checked && !st.busy ? '' : 'disabled'}>${t.agree}</button>
          </div>
          ${mode === 'gate' ? html`<details class="legal-other"><summary>${t.other}</summary>
            <p>${t.otherText}</p>
            <p><a class="legal-link" href="/api/me/export" download>${t.download}</a></p>
            ${own ? html`<form class="legal-delete" data-delete>
              <label>${t.password}<input type="password" name="password" autocomplete="current-password" required></label>
              <label>${t.typeDelete}<input name="confirm" pattern="DELETE" required autocomplete="off"></label>
              <button class="legal-btn legal-btn-danger">${t.deleteAccount}</button></form>` : ''}
          </details>` : ''}
        </footer>`}
      </div>`);
    }

    root.addEventListener('click', async (e) => {
      const target = e.target.closest('button, a');
      if (!target) return;
      if (target.dataset.lang) {
        if (target.dataset.lang !== st.lang) await load(target.dataset.lang);
      } else if (target.dataset.tab) {
        st.tab = target.dataset.tab;
        paint();
        $('.legal-main', root)?.scrollTo?.({ top: 0 });
      } else if ('retry' in target.dataset) {
        load(st.lang);
      } else if ('close' in target.dataset) {
        done(null);
      } else if ('decline' in target.dataset) {
        if (mode === 'gate') await signOut?.();
        done(false);
      } else if ('agree' in target.dataset) {
        if (mode === 'ask') {
          done(true);
          return;
        }
        st.busy = true;
        paint();
        try {
          await api.post('/agreement/accept', { version: st.doc.version, accept: true, via: 'prompt' });
          setSession({ agreement: { required: false, version: st.doc.version } });
          done(true);
        } catch (error) {
          st.busy = false;
          paint();
          toastError(error);
        }
      }
    });
    root.addEventListener('change', (e) => {
      if (e.target.matches('[data-check]')) {
        st.checked = e.target.checked;
        const go = $('[data-agree]', root);
        if (go) go.disabled = !st.checked;
      }
    });
    root.addEventListener('submit', async (e) => {
      if (!e.target.matches('[data-delete]')) return;
      e.preventDefault();
      try {
        await api.post('/me/delete', Object.fromEntries(new FormData(e.target)));
        toast(WORDS[st.lang].deleted, 'success');
        await signOut?.();
        done(false);
      } catch (error) {
        toastError(error);
      }
    });

    paint();
    load('de'); // German first
  });
}

/** The page for someone who must accept before anything else. */
export const agreementGate = ({ signOut } = {}) => open({ mode: 'gate', signOut });
/** The same page for a guest joining a lecture: true when they agree. */
export const askAgreement = ({ role = 'guest' } = {}) => open({ mode: 'ask', role });
/** To read only (before registering, or from Settings). */
export const readAgreement = ({ role } = {}) => open({ mode: 'read', role });

/** A line for Settings: who accepted what, when. (Interface language.) */
export const acceptedLine = (accepted) => (accepted?.current
  ? `You accepted version ${accepted.version}${accepted.at ? ` on ${new Date(accepted.at).toLocaleDateString()}` : ''}.`
  : 'You have not accepted the current version yet.');
