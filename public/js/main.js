/** Boot: load the session, mount the right frame, start routing. */
import { api } from './core/api.js';
import { session, setSession, on } from './core/store.js';
import { startRouter, navigate } from './core/router.js';
import { live } from './core/live.js';
import { registerRoutes } from './routes.js';
import { mountApp, mountPublic, setTheme, signOut } from './shell.js';
import { agreementGate } from './features/agreement.js';
import { startTranslating, syncFromUser } from './core/i18n.js';
import { watchDates } from './features/date-picker.js';

async function boot() {
  registerRoutes();
  watchDates(document.body); // dates are picked in the Citrus look, not the browser's

  let data = {};
  try {
    data = await api.get('/bootstrap', { quiet401: true });
  } catch {
    /* offline: public frame will show */
  }
  setSession({
    user: data.user || null,
    site: { ...session.site, ...(data.site || {}) },
    ai: data.ai || null,
    unread: data.unread || 0,
    sso: data.sso || session.sso,
    registration: data.registration !== false,
    guests: !!data.guests,
    durable: data.durable !== false,
    institutions: data.institutions || [],
    agreement: data.agreement || null,
  });

  const theme = data.user?.preferences?.theme;
  // An account's saved theme applies unless this device already has its own choice (the dark default does not count).
  const own = document.documentElement.dataset.theme && !document.documentElement.dataset.themeDefault;
  if (theme && theme !== 'system' && !own) setTheme(theme);

  // Language and the assistant's name first, so nothing flashes in the wrong language.
  await startTranslating({ language: data.user?.preferences?.language, assistantName: data.user?.preferences?.assistantName });
  on('session', (patch) => {
    if ('user' in patch) syncFromUser(patch.user);
  });

  // Nobody gets into the app without accepting the current Data Service and Privacy Agreement.
  if (session.user && session.agreement?.required) {
    await agreementGate({ signOut: async () => { await api.post('/logout').catch(() => {}); setSession({ user: null, unread: 0, ai: null }); } });
  }
  if (session.user) mountApp();
  else mountPublic();

  // It changed while the app was open: ask again, then reload with the new version.
  let asking = false;
  on('agreement', async () => {
    if (asking || !session.user) return;
    asking = true;
    const accepted = await agreementGate({ signOut });
    asking = false;
    if (accepted) location.reload();
  });

  // One failed request is not a sign-out: confirm with the server first, so a stray 401 never drops someone mid-use.
  let checking = false;
  on('unauthorized', async () => {
    if (!session.user || checking) return;
    checking = true;
    try {
      await api.get('/bootstrap', { quiet401: true });
      return;
    } catch (error) {
      if (error.status !== 401) return;
    } finally {
      checking = false;
    }
    if (!session.user) return;
    live.disconnect();
    setSession({ user: null, unread: 0 });
    mountPublic();
    navigate(`/login?return=${encodeURIComponent(location.pathname)}`, { replace: true });
  });

  await startRouter();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
