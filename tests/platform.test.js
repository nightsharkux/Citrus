'use strict';
/** Platform: editions, capability registry, front-end structure, security headers, SPA routing. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { siteConfig, publicSite } = require('../config/site');
const catalog = require('../config/capabilities');
const { startApp } = require('./helpers');

const root = path.resolve(__dirname, '..');

test('one codebase serves both university editions', () => {
  const oth = siteConfig({ CAMPUS_EDITION: 'oth' });
  const general = siteConfig({ CAMPUS_EDITION: 'general' });
  assert.equal(oth.id, 'oth');
  assert.equal(general.id, 'general');
  assert.notEqual(oth.accent, general.accent);
  assert.equal(oth.version, general.version);
  assert.ok(oth.campuses.length === 2 && oth.links.length > 3);
  assert.ok(!('knowledgePack' in publicSite(oth)), 'server-only fields stay on the server');
});

test('capability registry is consistent and honest', () => {
  const seen = new Set();
  for (const group of catalog) {
    assert.ok(group.items.length);
    for (const item of group.items) {
      assert.ok(!seen.has(item.id), `duplicate ${item.id}`);
      seen.add(item.id);
      assert.ok(['available', 'limited', 'configuration', 'planned'].includes(item.status));
      assert.ok(item.label && item.description);
      if (item.status === 'planned') assert.equal(item.route, null, `${item.id} is planned and must not link to a page`);
      else assert.match(item.route, /^\//);
    }
  }
  assert.ok(seen.size >= 30);
});

test('every routed page module exists and the shell loads the app as an ES module', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /type="module" src="\/js\/main.js"/);
  assert.match(html, /manifest.webmanifest/);
  const routes = fs.readFileSync(path.join(root, 'public/js/routes.js'), 'utf8');
  const pages = [...routes.matchAll(/import\('\.\/(pages\/[^']+)'\)/g)].map((m) => m[1]);
  assert.ok(pages.length >= 25);
  for (const page of pages) assert.ok(fs.existsSync(path.join(root, 'public/js', page)), `missing ${page}`);
  const worker = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
  assert.match(worker, /startsWith\('\/api\/'\)/, 'service worker must never cache API responses');
});

test('security headers, CSRF protection, SPA routing and versioned API alias', async () => {
  const app = await startApp();
  try {
    const page = await app.call('anon', 'GET', '/courses/12');
    assert.equal(page.status, 200);
    assert.match(page.body, /data-edition="oth"/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');

    assert.equal((await app.call('anon', 'GET', '/api/nope')).status, 404);
    assert.equal((await app.call('anon', 'GET', '/api/courses')).status, 401);
    assert.equal((await app.call('anon', 'GET', '/api/v1/health')).body.ok, true);

    await app.login('admin');
    assert.equal((await app.call('admin', 'GET', '/api/v1/courses')).status, 200, '/api/v1 aliases /api');
    const crossSite = await app.call('admin', 'POST', '/api/suggestions', { message: 'From another site' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);

    const caps = await app.call('anon', 'GET', '/api/v1/capabilities');
    assert.equal(caps.status, 200);
    const student = await app.register('stu');
    assert.equal(student.status, 201);
    const visible = (await app.call('stu', 'GET', '/api/v1/capabilities')).body.groups.flatMap((g) => g.items.map((i) => i.id));
    assert.ok(!visible.includes('devices'), 'admin-only tools are hidden from students');
  } finally {
    await app.close();
  }
});

test('the address comes from Vercel variables, with localhost as the local default', () => {
  const { loadConfig } = require('../src/config');
  const local = loadConfig({ PORT: '4000' });
  assert.equal(local.publicUrl, 'http://localhost:4000');
  assert.equal(local.hosted, false);
  assert.equal(local.trustProxy, false);
  assert.equal(local.cookieSecure, false);

  const production = loadConfig({ VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'campus.example.edu', VERCEL_URL: 'campus-abc.vercel.app' });
  assert.equal(production.publicUrl, 'https://campus.example.edu', 'production uses the stable production domain');
  assert.equal(production.hosted, true);
  assert.equal(production.cookieSecure, true);
  assert.equal(production.oidc.redirectUri, 'https://campus.example.edu/auth/sso/callback');

  const preview = loadConfig({ VERCEL_ENV: 'preview', VERCEL_PROJECT_PRODUCTION_URL: 'campus.example.edu', VERCEL_URL: 'campus-abc.vercel.app' });
  assert.equal(preview.publicUrl, 'https://campus-abc.vercel.app', 'previews use their own deployment address');

  const dev = loadConfig({ VERCEL_ENV: 'development', VERCEL_URL: 'localhost:3000' });
  assert.equal(dev.hosted, false, 'vercel dev behaves like a local run');
  assert.equal(loadConfig({ VERCEL_ENV: 'production', VERCEL_URL: 'campus-abc.vercel.app' }).publicUrl, 'https://campus-abc.vercel.app');
  assert.equal(loadConfig({ OIDC_REDIRECT_URI: 'https://sso.example.edu/cb' }).oidc.redirectUri, 'https://sso.example.edu/cb');
});

test('works behind a reverse proxy with an https public address', async () => {
  const { clientIp } = require('../src/http/security');
  const req = { headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIp(req, true), '203.0.113.9', 'the hop added by our proxy, not a client-forged one');
  assert.equal(clientIp(req, false), '127.0.0.1', 'forwarded headers are ignored unless TRUST_PROXY is set');

  const app = await startApp({ env: { VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'campus.example.edu', VERCEL_URL: 'campus-abc123.vercel.app' } });
  try {
    assert.equal(app.config.publicUrl, 'https://campus.example.edu');
    assert.equal(app.config.trustProxy, true, 'Vercel is always a proxy');
    const reg = await app.register('stu');
    assert.match(reg.headers.get('set-cookie'), /; Secure/, 'https deployments get Secure cookies');
    assert.match(reg.headers.get('strict-transport-security'), /max-age/);
    const viaProxy = await app.call('stu', 'POST', '/api/suggestions', { message: 'Sent through the proxy' }, { headers: { origin: 'https://campus.example.edu' } });
    assert.equal(viaProxy.status, 201, 'the Vercel production origin is accepted even if the proxy rewrites Host');
    const forged = await app.call('stu', 'POST', '/api/suggestions', { message: 'From another site' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(forged.status, 403);
  } finally {
    await app.close();
  }
});

test('online backup snapshots a running database and applies retention', async () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const app = await startApp();
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campusos-backups-'));
  try {
    await app.register('stu');
    const run = () => execFileSync(process.execPath, [path.join(root, 'scripts/backup.js')], { env: { ...process.env, DB_PATH: app.config.dbPath, BACKUP_DIR: backupDir, BACKUP_KEEP: '2' }, encoding: 'utf8' });
    for (let i = 0; i < 3; i += 1) {
      run();
      await new Promise((r) => setTimeout(r, 15));
    }
    const folders = fs.readdirSync(backupDir);
    assert.equal(folders.length, 2, 'only the newest BACKUP_KEEP backups remain');
    const copy = path.join(backupDir, folders[0]);
    assert.ok(fs.existsSync(path.join(copy, 'master.key')) && fs.existsSync(path.join(copy, 'vapid.json')));
    const { DatabaseSync } = require('node:sqlite');
    const restored = new DatabaseSync(path.join(copy, 'test.db'), { readOnly: true });
    assert.equal(restored.prepare("SELECT COUNT(*) n FROM users WHERE email = 'stu@test.invalid'").get().n, 1);
    restored.close();
  } finally {
    await app.close();
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
});

test('login is rate limited per account after repeated failures', async () => {
  const app = await startApp();
  try {
    await app.register('target');
    for (let i = 0; i < 8; i += 1) assert.equal((await app.call('x', 'POST', '/api/login', { email: 'target@test.invalid', password: 'wrong-password-xx' })).status, 401);
    const locked = await app.call('x', 'POST', '/api/login', { email: 'target@test.invalid', password: 'Member-password-for-tests-1' });
    assert.equal(locked.status, 429);
  } finally {
    await app.close();
  }
});

test('migration script will not overwrite an existing database', () => {
  assert.match(fs.readFileSync(path.join(root, 'scripts/import-storage.js'), 'utf8'), /Refusing to overwrite/);
});
