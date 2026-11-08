/** Boot: load the session, mount the right frame, start routing. */
import { api } from './core/api.js';
import { session, setSession, on } from './core/store.js';
import { startRouter, navigate } from './core/router.js';
import { live } from './core/live.js';
import { registerRoutes } from './routes.js';
import { mountApp, mountPublic, setTheme } from './shell.js';

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
    institutions: data.institutions || [],
  });

  const theme = data.user?.preferences?.theme;
  if (theme && theme !== 'system' && !document.documentElement.dataset.theme) setTheme(theme);

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
