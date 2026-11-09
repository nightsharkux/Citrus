/** Boot: load the session, mount the right frame, start routing. */
import { api } from './core/api.js';
import { session, setSession, on } from './core/store.js';
import { startRouter, navigate } from './core/router.js';
import { live } from './core/live.js';
import { registerRoutes } from './routes.js';
import { mountApp, mountPublic, setTheme } from './shell.js';
import { startTranslating, syncFromUser } from './core/i18n.js';

async function boot() {
  registerRoutes();

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
    durable: data.durable !== false,
    institutions: data.institutions || [],
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

  if (session.user) mountApp();
  else mountPublic();

  on('unauthorized', () => {
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
