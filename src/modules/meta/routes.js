'use strict';
/** Public metadata for clients, monitoring and the "All tools" directory. */
const capabilities = require('../../../config/capabilities');

function register(router, { db, config }) {
  const started = Date.now();

  router.get('/api/v1/meta', () => ({
    product: 'Campus OS',
    version: config.site.version,
    edition: config.site.id,
    mode: config.site.mode,
    apiVersion: 1,
    featuresEndpoint: '/api/v1/capabilities',
    deviceProtocol: 'campusos-device/1',
  }), { auth: 'public' });

  router.get('/api/v1/capabilities', (ctx) => {
    const role = ctx.user?.role;
    const groups = capabilities.map((g) => ({ group: g.group, items: g.items.filter((i) => !role || !i.roles || i.roles.includes(role)) }));
    return { version: 2, groups };
  }, { auth: 'public' });

  router.get('/api/v1/health', () => {
    let database = 'ok';
    try {
      db.get('SELECT 1');
    } catch {
      database = 'error';
    }
    return { ok: database === 'ok', version: config.site.version, database, uptimeSeconds: Math.round((Date.now() - started) / 1000) };
  }, { auth: 'public' });

  /** The ring logo in this edition's colours (browser tab icon, social previews). */
  router.get('/brand/mark.svg', (ctx) => {
    const [a, b, c] = config.site.palette.aurora;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>${config.site.shortName}</title>`
      + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs>`
      + '<circle cx="50" cy="50" r="37" fill="none" stroke="url(#g)" stroke-width="17"/></svg>';
    ctx.res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    ctx.res.end(svg);
  }, { auth: 'public' });

  /** Raster app icon for this edition (notifications need PNG). */
  router.get('/brand/icon.png', (ctx) => {
    const file = require('node:path').join(config.publicDir, 'icons', `${config.site.id}-192.png`);
    ctx.res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    require('node:fs').createReadStream(file).on('error', () => ctx.res.end()).pipe(ctx.res);
  }, { auth: 'public' });

  router.get('/manifest.webmanifest', (ctx) => {
    const manifest = {
      name: config.site.name,
      short_name: config.site.shortName,
      description: 'Your university, in one place.',
      start_url: '/home',
      scope: '/',
      display: 'standalone',
      // Neutral, so the installed app has no coloured bar or splash edge; dark like the app by default; the page sets light or dark at run time.
      background_color: '#0C0A17',
      theme_color: '#0C0A17',
      icons: [
        { src: `/icons/${config.site.id}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: `/icons/${config.site.id}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        { src: '/brand/mark.svg', sizes: 'any', type: 'image/svg+xml' },
      ],
      shortcuts: [
        { name: `Ask ${config.site.assistant}`, url: '/assistant' },
        { name: 'Schedule', url: '/schedule' },
        { name: 'Inbox', url: '/inbox' },
      ],
    };
    ctx.res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    ctx.res.end(JSON.stringify(manifest));
  }, { auth: 'public' });
}

module.exports = { register };
