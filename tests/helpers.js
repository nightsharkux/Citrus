'use strict';
/**
 * Test harness: boots an isolated CampusOS instance (temp database, temp
 * storage) on a random port, with a cookie jar per named user.
 *
 *   const app = await startApp({ env: { ... }, fetchImpl });
 *   await app.login('admin');
 *   const r = await app.call('admin', 'GET', '/api/courses');
 *   await app.close();
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db/database');
const { runMigrations } = require('../src/db/migrate');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');

const ADMIN = { email: 'admin@test.invalid', password: 'Admin-password-for-tests-1' };
const PASSWORD = 'Member-password-for-tests-1';

async function startApp({ env = {}, fetchImpl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campusos-test-'));
  const fullEnv = { CAMPUS_ADMIN_EMAIL: ADMIN.email, CAMPUS_ADMIN_PASSWORD: ADMIN.password, DB_PATH: path.join(dir, 'test.db'), AI_GATEWAY_API_KEY: '', CAMPUS_AI_PROVIDER: 'off', ...env };
  const config = loadConfig(fullEnv);
  const db = openDatabase(config.dbPath);
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
  const register = (who, { name = who, email = `${who}@test.invalid`, role = 'student' } = {}) => call(who, 'POST', '/api/register', { name: `${name[0].toUpperCase()}${name.slice(1)} Person`, email, password: PASSWORD, role });

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
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { base, call, login, register, lecturer, close, db, config, app, dir };
}

module.exports = { startApp, ADMIN, PASSWORD };
