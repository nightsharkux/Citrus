'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openRemoteDatabase } = require('../src/db/remote');
const { runMigrations } = require('../src/db/migrate');
const { loadConfig } = require('../src/config');
const { createKeys } = require('../src/services/keys');
const { startApp, startFakeTurso, TURSO_TOKEN } = require('./helpers');

test('hosted database driver: queries, named values, blobs, transactions and errors', async () => {
  const fake = await startFakeTurso();
  const db = openRemoteDatabase({ url: fake.url, authToken: TURSO_TOKEN });
  try {
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT UNIQUE, n REAL, data BLOB, parent INTEGER REFERENCES t(id))');
    const id = db.insert('INSERT INTO t(name, n, data) VALUES(?, ?, ?)', 'a', 1.5, Buffer.from([1, 2, 3]));
    assert.equal(id, 1);
    const row = db.get('SELECT * FROM t WHERE id = ?', id);
    assert.equal(row.name, 'a');
    assert.equal(row.n, 1.5);
    assert.deepEqual([...row.data], [1, 2, 3]);
    assert.equal(db.get('SELECT * FROM t WHERE id = ?', 99), undefined);
    assert.equal(db.all('SELECT name FROM t WHERE name = @name', { name: 'a' }).length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM t').get().n, 1);
    assert.equal(db.run('UPDATE t SET n = ? WHERE id = ?', 2, id).changes, 1);
    assert.ok(db.columns('t').includes('parent'));
    assert.ok(db.hasTable('t') && !db.hasTable('missing'));

    assert.throws(() => db.run('INSERT INTO t(name) VALUES(?)', 'a'), /UNIQUE constraint failed/);
    assert.throws(() => db.run('INSERT INTO t(name, parent) VALUES(?, ?)', 'b', 404), /FOREIGN KEY/, 'foreign keys are enforced');

    // A failed transaction leaves nothing behind, including statements that were held back.
    assert.throws(() => db.transaction(() => {
      db.exec("INSERT INTO t(name) VALUES('gone')");
      db.run("INSERT INTO t(name) VALUES('gone-too')");
      db.exec('INSERT INTO nowhere VALUES(1)');
      db.run("INSERT INTO t(name) VALUES('never')");
    }), /nowhere/);
    assert.equal(db.get("SELECT COUNT(*) n FROM t WHERE name LIKE 'gone%'").n, 0);

    assert.throws(() => db.transaction(() => {
      db.run("INSERT INTO t(name) VALUES('rolled-back')");
      throw new Error('stop');
    }), /stop/);
    assert.equal(db.get("SELECT COUNT(*) n FROM t WHERE name = 'rolled-back'").n, 0);

    const result = db.transaction(() => {
      db.exec("INSERT INTO t(name) VALUES('kept')");
      const nested = db.transaction(() => db.insert("INSERT INTO t(name) VALUES('nested')"));
      return { nested, seen: db.get("SELECT COUNT(*) n FROM t WHERE name IN ('kept', 'nested')").n };
    });
    assert.equal(result.seen, 2, 'a transaction sees its own writes');
    assert.equal(db.get("SELECT COUNT(*) n FROM t WHERE name IN ('kept', 'nested')").n, 2);
  } finally {
    db.close();
    fake.child.kill();
  }
});

test('hosted database rejects a wrong token with a readable message', async () => {
  const fake = await startFakeTurso();
  try {
    assert.throws(() => openRemoteDatabase({ url: fake.url, authToken: 'wrong' }), /Could not connect to the database.*401/);
    assert.throws(() => openRemoteDatabase({ url: 'not a url', authToken: 'x' }), /TURSO_DATABASE_URL/);
  } finally {
    fake.child.kill();
  }
});

test('Campus OS runs on a hosted database, and its keys survive a restart', async () => {
  const app = await startApp({ remote: true });
  try {
    assert.equal(app.db.remote, true);
    const registered = await app.register('maya');
    assert.equal(registered.status, 201);
    assert.equal((await app.login('admin')).status, 200);
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Hosted course', code: 'HOST1' });
    assert.equal(course.status, 201, JSON.stringify(course.body));
    const listed = await app.call('admin', 'GET', '/api/courses');
    assert.ok(listed.body.courses.some((c) => c.code === 'HOST1' && c.id === course.body.id));
    assert.equal((await app.call('nobody', 'GET', '/api/courses')).status, 401, 'signed-out requests are still refused');

    // No storage/ folder is needed: keys are kept in the database and are stable across restarts.
    const keys = createKeys({ config: app.config, db: app.db, env: {} });
    const sealed = app.app.deps.secretBox.seal('device-secret');
    const again = createKeys({ config: app.config, db: app.db, env: {} });
    assert.deepEqual(keys.master(), again.master());
    assert.equal(keys.vapid().publicKey, again.vapid().publicKey);
    assert.equal(app.app.deps.secretBox.open(sealed), 'device-secret');
    assert.equal(app.db.get('SELECT COUNT(*) n FROM app_keys').n, 3);
    assert.equal(runMigrations(app.db), 0, 'migrations are already applied');

    // An explicit key from the environment wins over the stored one.
    const fromEnv = createKeys({ config: app.config, db: app.db, env: { CAMPUS_MASTER_KEY: 'a'.repeat(64) } });
    assert.deepEqual(fromEnv.master(), Buffer.from('a'.repeat(64), 'hex'));
    assert.throws(() => createKeys({ config: app.config, db: app.db, env: { CAMPUS_MASTER_KEY: 'short' } }).master(), /CAMPUS_MASTER_KEY must be 32 bytes/);
  } finally {
    await app.close();
  }
});

test('configuration picks the hosted database only when TURSO_DATABASE_URL is set', () => {
  assert.equal(loadConfig({}).database.url, '');
  assert.equal(loadConfig({ TURSO_DATABASE_URL: ' libsql://x.turso.io ', TURSO_AUTH_TOKEN: 't' }).database.url, 'libsql://x.turso.io');
});

test('reads go without the foreign key setting (it doubled every query on Turso); writes keep it and stay checked', async () => {
  const { spawn } = require('node:child_process');
  const fake = await startFakeTurso();
  // A proxy in its own process (the driver blocks this one while it waits) that records each pipeline it passes on.
  const script = `const http = require('node:http'); const sent = [];
    const s = http.createServer(async (req, res) => {
      if (req.url === '/__sent') { res.end(JSON.stringify(sent.splice(0))); return; }
      const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks).toString(); sent.push(body);
      const r = await fetch(process.argv[1] + req.url, { method: req.method, headers: { 'content-type': 'application/json', authorization: req.headers.authorization || '' }, body: req.method === 'GET' ? undefined : body });
      res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text());
    });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`;
  const child = spawn(process.execPath, ['-e', script, fake.url], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(String(chunk).trim())));
  const proxy = `http://127.0.0.1:${port}`;
  const sentSince = async () => (await (await fetch(`${proxy}/__sent`)).json());
  const db = openRemoteDatabase({ url: proxy, authToken: TURSO_TOKEN });
  const pragma = (body) => /PRAGMA foreign_keys/.test(body);
  try {
    db.exec('CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id) ON DELETE CASCADE)');
    db.insert('INSERT INTO p(id) VALUES(1)');
    db.insert('INSERT INTO c(p) VALUES(1)');
    await sentSince();
    db.get('SELECT * FROM p WHERE id = ?', 1);
    db.all('SELECT * FROM c');
    db.columns('c');
    const reads = await sentSince();
    assert.equal(reads.length, 3);
    assert.ok(!reads.some(pragma), 'reads are sent alone');
    db.run('DELETE FROM p WHERE id = ?', 1);
    assert.ok(pragma((await sentSince())[0]), 'a write switches the checks on');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM c').n, 0, 'so deleting cascades');
    assert.throws(() => db.run('INSERT INTO c(p) VALUES(?)', 404), /FOREIGN KEY/);
    await sentSince();
    db.transaction(() => {
      db.get('SELECT 1 AS one');
      db.run('INSERT INTO p(id) VALUES(2)');
    });
    assert.ok(pragma((await sentSince())[0]), 'a transaction too, from its first statement');
  } finally {
    db.close();
    child.kill();
    fake.child.kill();
  }
});

test('after a transaction fails on the way to the database, the next query starts a new stream', async () => {
  const { spawn } = require('node:child_process');
  const fake = await startFakeTurso();
  // Fails the request that writes 'boom' (inside a transaction) with a server error; passes everything else on.
  const script = `const http = require('node:http'); const sent = [];
    const s = http.createServer(async (req, res) => {
      if (req.url === '/__sent') { res.end(JSON.stringify(sent.splice(0))); return; }
      const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks).toString(); sent.push(body);
      if (body.includes('boom')) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"bad gateway"}'); return; }
      const r = await fetch(process.argv[1] + req.url, { method: req.method, headers: { 'content-type': 'application/json', authorization: req.headers.authorization || '' }, body: req.method === 'GET' ? undefined : body });
      res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text());
    });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`;
  const child = spawn(process.execPath, ['-e', script, fake.url], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(String(chunk).trim())));
  const proxy = `http://127.0.0.1:${port}`;
  const db = openRemoteDatabase({ url: proxy, authToken: TURSO_TOKEN });
  try {
    db.exec('CREATE TABLE t(name TEXT)');
    assert.throws(() => db.transaction(() => {
      db.run("INSERT INTO t(name) VALUES('fine')");
      db.run("INSERT INTO t(name) VALUES('boom')");
    }), /502/);
    await (await fetch(`${proxy}/__sent`)).json();
    assert.equal(db.get('SELECT COUNT(*) AS n FROM t').n, 0, 'the failed transaction left nothing, and the next query works');
    const [next] = await (await fetch(`${proxy}/__sent`)).json();
    assert.equal(JSON.parse(next).baton, null, 'on a new stream, not the one that failed');
  } finally {
    db.close();
    child.kill();
    fake.child.kill();
  }
});
