'use strict';
/** Public metadata for clients, monitoring and the "All tools" directory. */
const capabilities = require('../../../config/capabilities');
const { markSvg } = require('../../lib/brand-mark');

function register(router, { db, config }) {
  const started = Date.now();

  router.get('/api/v1/meta', () => ({
    product: 'Citrus',
    version: config.site.version,
    edition: config.site.id,
    mode: config.site.mode,
    apiVersion: 1,
    featuresEndpoint: '/api/v1/capabilities',
    deviceProtocol: 'citrus-device/1',
  }), { auth: 'public' });

  router.get('/api/v1/capabilities', (ctx) => {
    const role = ctx.user?.role;
    const groups = capabilities.map((g) => ({ group: g.group, items: g.items.filter((i) => !role || !i.roles || i.roles.includes(role)) }));
    return { version: 2, groups };
  }, { auth: 'public' });

  /**
   * databaseMs: one round trip to the database, measured here (the middle of three). With a hosted database it
   * should be a few milliseconds; much more means the database is far from the server's region (vercel.json),
   * and every page pays it once per query.
   */
  router.get('/api/v1/health', () => {
    let database = 'ok';
    let databaseMs = null;
    let databaseSince = null;
    try {
      // When this database was set up: it should not change between deploys (a new date means a fresh, empty one).
      databaseSince = db.get('SELECT applied_at FROM schema_migrations WHERE version = 1')?.applied_at || null;
      const times = [0, 1, 2].map(() => {
        const t = process.hrtime.bigint();
        db.get('SELECT 1');
        return Number(process.hrtime.bigint() - t) / 1e6;
      }).sort((a, b) => a - b);
      databaseMs = Math.round(times[1] * 10) / 10;
    } catch {
      database = 'error';
    }
    return { ok: database === 'ok', version: config.site.version, database, databaseMs, databaseSince, region: process.env.VERCEL_REGION || null, uptimeSeconds: Math.round((Date.now() - started) / 1000) };
  }, { auth: 'public' });

  /** The Citrus slice mark (browser tab icon, the mark in the pages, social previews): src/lib/brand-mark.js. */
  router.get('/brand/mark.svg', (ctx) => {
    ctx.res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
    ctx.res.end(markSvg(config.site.shortName));
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
        { src: `/icons/${config.site.id}-192.png?v=slice`, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: `/icons/${config.site.id}-512.png?v=slice`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        { src: '/brand/mark.svg?v=slice', sizes: 'any', type: 'image/svg+xml' },
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
