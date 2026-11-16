'use strict';
/**
 * Starting up next to other instances right after a deploy: first-run data is added once, and an instance that
 * could not start tries again instead of answering 503 for as long as it lives.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startApp, startFakeTurso, TURSO_TOKEN } = require('./helpers');
const { seed } = require('../src/db/seed');

test('first-run data is added once, even when a starting instance does not see the university yet', async () => {
  const app = await startApp();
  try {
    const before = app.db.get('SELECT COUNT(*) AS n FROM institutions').n;
    // What production saw: the read came back empty although the university was there, and the insert failed.
    const blind = { ...app.db, get: (sql, ...args) => (/FROM institutions LIMIT 1/.test(sql) ? undefined : app.db.get(sql, ...args)) };
    const config = { ...app.config, seed: { ...app.config.seed, adminPassword: 'Another-admin-password-1', adminEmail: 'second@test.invalid' } };
    assert.doesNotThrow(() => seed(blind, config, () => {}));
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM institutions').n, before);
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM users WHERE email = 'second@test.invalid'").n, 0, 'and no second administrator');
  } finally {
    await app.close();
  }
});

/** Lets requests through to the stand-in database only once `up` is set: before that, it is unreachable. */
async function gate(target) {
  const state = { up: false };
  const server = http.createServer(async (req, res) => {
    if (!state.up) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end('{"error":"starting"}');
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const r = await fetch(target + req.url, { method: req.method, headers: { 'content-type': 'application/json', authorization: req.headers.authorization || '' }, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('on Vercel, an instance that could not start tries again on a later request', async () => {
  const fake = await startFakeTurso();
  const door = await gate(fake.url);
  const script = `const http = require('node:http'); const h = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    const s = http.createServer(h); s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));`;
  const child = spawn(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, VERCEL: '1', TURSO_DATABASE_URL: door.url, TURSO_AUTH_TOKEN: TURSO_TOKEN, CAMPUS_STARTUP_RETRY_MS: '200', CAMPUS_AI_PROVIDER: 'off', CAMPUS_BUNDLED_KNOWLEDGE: 'off', AI_GATEWAY_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const m = /PORT (\d+)/.exec(out);
        if (m) resolve(Number(m[1]));
      });
      child.once('exit', (code) => reject(new Error(`server exited (${code}): ${errors}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const down = await fetch(`${base}/api/bootstrap`);
    assert.equal(down.status, 503, 'the database was out of reach when it started');
    assert.match(errors, /could not start/);

    door.state.up = true;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const up = await fetch(`${base}/api/bootstrap`);
    assert.equal(up.status, 200, await up.clone().text());
    assert.ok((await up.json()).institutions.length >= 1, 'migrated and seeded on the second try');
  } finally {
    child.kill();
    await door.close();
    fake.child.kill();
  }
});
