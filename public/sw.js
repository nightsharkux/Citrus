/**
 * Service worker: offline app shell + Web Push.
 * Network-first for everything; private API responses are never cached.
 */
const CACHE = 'citrus-1.1.0-slice';
const SHELL = ['/', '/css/tokens.css', '/css/base.css', '/css/components.css', '/css/layout.css', '/css/pages.css', '/css/face.css', '/js/main.js', '/js/theme-boot.js', '/brand/mark.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/calendar/')) return;

  const isPage = req.mode === 'navigate';
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (isPage || /\.(css|js|png|svg|jpg|webmanifest)$/.test(url.pathname))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(isPage ? '/' : req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(isPage ? '/' : req)) || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } })),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Citrus', body: event.data?.text() || '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Citrus', {
    body: data.body || '',
    icon: '/brand/icon.png',
    badge: '/brand/icon.png',
    tag: data.id ? `n-${data.id}` : undefined,
    data: { link: data.link || '/inbox' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link || '/inbox';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ('focus' in w) {
          w.navigate(link).catch(() => {});
          return w.focus();
        }
      }
      return self.clients.openWindow(link);
    }),
  );
});
