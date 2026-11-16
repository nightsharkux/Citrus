/**
 * History-API router with page lifecycle.
 *
 * A page module exports default {
 *   title: string | (data, ctx) => string,
 *   roles?: ['student' | 'lecturer' | 'admin'],
 *   public?: true,                   // reachable when signed out
 *   layout?: 'wide' | 'full' | (session) => 'wide' | 'full' | '',
 *   load?(ctx) => Promise<data>,
 *   render(data, ctx) => template,
 *   mount?(root, data, ctx) => cleanup?,
 * }
 *
 * ctx = { params, query, navigate, refresh, live, setTitle }
 */
import { render } from './dom.js';
import { session, emit } from './store.js';
import { skeletonPage, errorState } from './components.js';
import { live } from './live.js';
import { closeAllSheets } from './ui.js';

const routes = [];
let current = null;
let viewEl = null;
let renderToken = 0;

export function route(pattern, loader) {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/\/:(\w+)\??/g, (m, key) => {
    keys.push(key);
    return m.endsWith('?') ? '(?:/([^/]+))?' : '/([^/]+)';
  })}/?$`);
  routes.push({ pattern, regex, keys, loader });
}

function match(path) {
  for (const r of routes) {
    const m = r.regex.exec(path);
    if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1] ? decodeURIComponent(m[i + 1]) : undefined])) };
  }
  return null;
}

export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, location.origin);
  if (url.origin !== location.origin) {
    location.href = to;
    return;
  }
  if (replace) history.replaceState({}, '', url.pathname + url.search);
  else history.pushState({}, '', url.pathname + url.search);
  show({ scroll: true });
}

export const currentPath = () => location.pathname;

/** Render the current URL. Never rejects: failures show an error state instead of freezing the app. */
function show(options) {
  return renderRoute(options).catch((error) => {
    console.error('Navigation failed', error);
    const el = document.getElementById('view');
    if (el) render(el, errorState(error));
  });
}

async function renderRoute({ scroll = false, soft = false } = {}) {
  const token = ++renderToken;
  const path = location.pathname === '/' && session.user ? '/home' : location.pathname;
  const found = match(path) || match('/404');
  const module = (await found.route.loader()).default;

  if (!module.public && !session.user) {
    navigate(`/login?return=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
    return;
  }
  if (module.public && session.user && ['/', '/login', '/register'].includes(path)) {
    navigate('/home', { replace: true });
    return;
  }
  if (module.roles && !module.roles.includes(session.user?.role)) {
    navigate('/home', { replace: true });
    return;
  }

  if (!soft) {
    teardown();
    closeAllSheets();
  }

  viewEl = document.getElementById('view');
  if (!viewEl) return;
  viewEl.className = `view ${(typeof module.layout === 'function' ? module.layout(session) : module.layout) || ''}`;

  const offs = [];
  const ctx = {
    params: found.params,
    query: new URLSearchParams(location.search),
    navigate,
    refresh: () => show({ soft: true }),
    live: { on: (type, fn) => offs.push(live.on(type, fn)) },
    setTitle: (t) => setTitle(t),
  };

  let skeletonTimer = null;
  if (!soft) skeletonTimer = setTimeout(() => token === renderToken && render(viewEl, module.skeleton?.() || skeletonPage()), 140);

  let data;
  try {
    data = module.load ? await module.load(ctx) : null;
  } catch (error) {
    clearTimeout(skeletonTimer);
    if (token !== renderToken) return;
    if (error.status === 401) return;
    render(viewEl, errorState(error));
    return;
  }
  clearTimeout(skeletonTimer);
  if (token !== renderToken) return;

  const scrollY = window.scrollY;
  if (soft) teardown();
  const entry = { module, cleanup: null, liveOff: offs, closed: false };
  current = entry;
  try {
    render(viewEl, module.render(data, ctx));
    if (!soft) {
      viewEl.classList.remove('view-enter');
      void viewEl.offsetWidth;
      viewEl.classList.add('view-enter');
    }
    setTitle(typeof module.title === 'function' ? module.title(data, ctx) : module.title);
    if (scroll) window.scrollTo(0, 0);
    else if (soft) window.scrollTo(0, scrollY);
    adoptCleanup(entry, module.mount?.(viewEl, data, ctx));
  } catch (error) {
    // A broken page must never break navigation for the rest of the app.
    console.error(`Page ${location.pathname} failed to render`, error);
    render(viewEl, errorState(error));
  }
  emit('route', { path: location.pathname });
}

/** mount() may return a cleanup function, or a promise of one (async mount). */
function adoptCleanup(entry, result) {
  if (typeof result === 'function') {
    entry.cleanup = result;
  } else if (result && typeof result.then === 'function') {
    result
      .then((fn) => {
        if (typeof fn !== 'function') return;
        if (entry.closed) fn(); // the user already left the page
        else entry.cleanup = fn;
      })
      .catch((error) => console.error('Page mount failed', error));
  }
}

function teardown() {
  const entry = current;
  current = null;
  if (!entry) return;
  entry.closed = true;
  try {
    entry.cleanup?.();
  } catch (error) {
    console.error('Page cleanup failed', error);
  }
  for (const off of entry.liveOff || []) {
    try {
      off();
    } catch {
      /* listener already removed */
    }
  }
}

function setTitle(title) {
  document.title = title ? `${title} · ${session.site.shortName || 'Citrus'}` : session.site.name || 'Citrus';
  emit('title', title);
}

/** Intercept same-origin link clicks so navigation stays in the app. */
function interceptLinks(event) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const a = event.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download') || a.dataset.native !== undefined) return;
  const url = new URL(a.href, location.origin);
  if (url.origin !== location.origin) return;
  if (/^\/(api|auth|calendar)\//.test(url.pathname) || /\.[a-z0-9]+$/i.test(url.pathname)) return;
  event.preventDefault();
  if (url.pathname === location.pathname && url.search === location.search) {
    if (url.hash === '') show({ soft: true });
    return;
  }
  navigate(url.pathname + url.search);
}

/** Load a page's code as soon as the pointer is on its link (or it is focused or touched), so the click finds it ready. */
function warm(path) {
  const found = match(path);
  if (!found || found.route.warm) return;
  found.route.warm = found.route.loader().catch(() => {
    found.route.warm = null; // try again next time
  });
}
function prefetch(event) {
  const a = event.target.closest?.('a[href]');
  if (!a || a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.origin);
  if (url.origin !== location.origin || /^\/(api|auth|calendar)\//.test(url.pathname) || /\.[a-z0-9]+$/i.test(url.pathname)) return;
  warm(url.pathname);
}

export function startRouter() {
  document.addEventListener('click', interceptLinks);
  for (const type of ['pointerover', 'focusin', 'touchstart']) document.addEventListener(type, prefetch, { passive: true });
  window.addEventListener('popstate', () => show());
  // The assistant is where people go most: get it ready once the first page is up and the browser is idle.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
  return show().then(() => idle(() => session.user && warm('/assistant')));
}

export const reload = () => show({ soft: true });
