'use strict';
/**
 * Test harness: boots an isolated Citrus instance (temp database, temp
 * storage) on a random port, with a cookie jar per named user.
 *
 *   const app = await startApp({ env: { ... }, fetchImpl });
 *   await app.login('admin');
 *   const r = await app.call('admin', 'GET', '/api/courses');
 *   await app.close();
 *
 * Set CAMPUS_TEST_DB=turso (or pass remote: true) to run against a stand-in
 * hosted database instead of a SQLite file; see tests/support/fake-turso.cjs.
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { spawn } = require('node:child_process');
const { openConfiguredDatabase } = require('../src/db/database');
const { runMigrations } = require('../src/db/migrate');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');

const ADMIN = { email: 'admin@test.invalid', password: 'Admin-password-for-tests-1' };
const PASSWORD = 'Member-password-for-tests-1';

const FAKE_TURSO = path.join(__dirname, 'support', 'fake-turso.cjs');
const TURSO_TOKEN = 'test-token';

/** Start the stand-in hosted database in its own process; resolves with its address. */
async function startFakeTurso({ delayMs = 0, commitMs = 0 } = {}) {
  const child = spawn(process.execPath, [FAKE_TURSO, TURSO_TOKEN], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, FAKE_TURSO_DELAY_MS: String(delayMs), FAKE_TURSO_COMMIT_MS: String(commitMs) } });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('The stand-in database stopped before it was ready')));
    child.stdout.once('data', (chunk) => resolve(String(chunk).trim()));
  });
  child.removeAllListeners('exit');
  return { child, url: `http://127.0.0.1:${port}` };
}

async function startApp({ env = {}, fetchImpl, remote = process.env.CAMPUS_TEST_DB === 'turso', databaseDelayMs = 0, databaseCommitMs = 0 } = {}) {
  const fake = remote ? await startFakeTurso({ delayMs: databaseDelayMs, commitMs: databaseCommitMs }) : null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citrus-test-'));
  const fullEnv = { CAMPUS_ADMIN_EMAIL: ADMIN.email, CAMPUS_ADMIN_PASSWORD: ADMIN.password, DB_PATH: path.join(dir, 'test.db'), AI_GATEWAY_API_KEY: '', CAMPUS_AI_PROVIDER: 'off', CAMPUS_BUNDLED_KNOWLEDGE: 'off', CAMPUS_REQUIRE_AGREEMENT: 'off', CAMPUS_DEFAULT_LANGUAGE: 'en', ...(fake ? { TURSO_DATABASE_URL: fake.url, TURSO_AUTH_TOKEN: TURSO_TOKEN } : {}), ...env };
  const config = loadConfig(fullEnv);
  const db = openConfiguredDatabase(config);
  runMigrations(db);
  seed(db, config, () => {});
  const app = createApp({ config, db, env: fullEnv, fetchImpl });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jars = {};

  async function call(who, method, url, body, { headers = {}, raw = false } = {}) {
    const isBuffer = Buffer.isBuffer(body);
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: { ...(jars[who] ? { cookie: jars[who] } : {}), ...(body !== undefined && !isBuffer ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isBuffer ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) jars[who] = setCookie.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  const login = (who, email = ADMIN.email, password = ADMIN.password) => call(who, 'POST', '/api/login', { email, password });
  const register = (who, { name = who, email = `${who}@test.invalid`, role = 'student' } = {}) => call(who, 'POST', '/api/register', { name: `${name[0].toUpperCase()}${name.slice(1)} Person`, email, password: PASSWORD, role, agree: true });

  /** Register a lecturer and approve them as admin (admin must be logged in as 'admin'). */
  async function lecturer(who) {
    const r = await register(who, { role: 'lecturer' });
    await call('admin', 'POST', '/api/admin/lecturer-applications', { user_id: r.body.user.id, decision: 'approve' });
    await login(who, `${who}@test.invalid`, PASSWORD);
    return r.body.user.id;
  }

  async function close() {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fake?.child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { base, call, login, register, lecturer, close, db, config, app, dir };
}

module.exports = { startApp, startFakeTurso, TURSO_TOKEN, ADMIN, PASSWORD };
