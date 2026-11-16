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

test('queries that do not block the caller run side by side, and never disturb a blocking call or a transaction', async () => {
  const fake = await startFakeTurso();
  const db = openRemoteDatabase({ url: fake.url, authToken: TURSO_TOKEN });
  try {
    db.exec('CREATE TABLE n(id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 1; i <= 20; i += 1) db.insert('INSERT INTO n(v) VALUES(?)', `row ${i}`);

    // Many at once: each gets its own answer.
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => db.batchAsync([['SELECT v FROM n WHERE id = ?', i + 1], ['SELECT COUNT(*) AS n FROM n']])));
    answers.forEach(([one, count], i) => {
      assert.equal(one[0].v, `row ${i + 1}`);
      assert.equal(count[0].n, 20);
    });

    // Blocking calls in the middle of them (answers that arrive meanwhile are handed to the right caller).
    const pending = Array.from({ length: 10 }, (_, i) => db.batchAsync([['SELECT v FROM n WHERE id = ?', i + 1]]));
    for (let i = 0; i < 5; i += 1) assert.equal(db.get('SELECT COUNT(*) AS n FROM n').n, 20);
    const settled = await Promise.all(pending);
    settled.forEach(([rows], i) => assert.equal(rows[0].v, `row ${i + 1}`));

    // Writes, in order inside one batch, are seen by the next read; constraint errors reject only their own batch.
    const [, afterWrite] = await db.batchAsync([['INSERT INTO n(v) VALUES(?)', 'late'], ['SELECT COUNT(*) AS n FROM n']]);
    assert.equal(afterWrite[0].n, 21);
    await assert.rejects(db.batchAsync([['INSERT INTO n(id, v) VALUES(1, ?)', 'dup']]), /UNIQUE/);
    assert.equal((await db.batchAsync([['SELECT COUNT(*) AS n FROM n']]))[0][0].n, 21, 'still works after an error');

    // A transaction is not joined by queries sent without blocking, and they do not break it.
    const during = [];
    const racing = Array.from({ length: 5 }, () => db.batchAsync([['SELECT COUNT(*) AS n FROM n']]).then(([rows]) => during.push(rows[0].n)));
    db.transaction(() => {
      db.run("INSERT INTO n(v) VALUES('in transaction')");
      assert.equal(db.get('SELECT COUNT(*) AS n FROM n').n, 22);
      // Inside a transaction batchAsync runs on its stream, so it sees the transaction's own changes.
      return db.batchAsync([['SELECT COUNT(*) AS n FROM n']]).then(([rows]) => during.push(`inside:${rows[0].n}`));
    });
    await Promise.all(racing);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM n').n, 22);
    assert.ok(during.filter((n) => typeof n === 'number').every((n) => n === 21 || n === 22), 'outside queries saw the data before or after, never half');
  } finally {
    db.close();
    fake.child.kill();
  }
});

test('a closed connection fails at once instead of waiting for an answer that never comes', async () => {
  const fake = await startFakeTurso();
  const db = openRemoteDatabase({ url: fake.url, authToken: TURSO_TOKEN });
  try {
    db.exec('CREATE TABLE c(id INTEGER)');
    const waitingForAnswer = db.batchAsync([['SELECT COUNT(*) AS n FROM c']]);
    db.close();
    await assert.rejects(waitingForAnswer, /closed/);
    const started = Date.now();
    assert.throws(() => db.get('SELECT 1'), /closed/);
    await assert.rejects(db.batchAsync([['SELECT 1']]), /closed/);
    assert.ok(Date.now() - started < 1000, 'no waiting');
  } finally {
    fake.child.kill();
  }
});

test('writes that arrive together are committed together; one caller\'s error does not touch the others', async () => {
  const { spawn } = require('node:child_process');
  const fake = await startFakeTurso();
  // Records each pipeline the driver sends (the driver blocks this process while it waits, so the proxy is its own).
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
  const db = openRemoteDatabase({ url: proxy, authToken: TURSO_TOKEN });
  const sent = async () => (await (await fetch(`${proxy}/__sent`)).json()).map((b) => JSON.stringify(JSON.parse(b)));
  try {
    db.exec('CREATE TABLE g(id INTEGER PRIMARY KEY, who TEXT UNIQUE, parent INTEGER REFERENCES g(id))');
    await sent();

    // Fifteen writers at once, each with a write and a read of its own row.
    const done = await Promise.all(Array.from({ length: 15 }, (_, i) => db.batchAsync([
      ['INSERT INTO g(who) VALUES(?)', `student ${i}`],
      ['SELECT id, who FROM g WHERE who = ?', `student ${i}`],
    ])));
    done.forEach(([, rows], i) => assert.equal(rows[0].who, `student ${i}`, 'each gets its own answer'));
    const pipelines = (await sent()).filter((b) => b.includes('BEGIN IMMEDIATE'));
    assert.ok(pipelines.length <= 2, `${pipelines.length} transactions for fifteen writers`);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM g').n, 15);

    // One of them fails (a duplicate): only that caller hears of it; the others are committed.
    const mixed = await Promise.allSettled([
      db.batchAsync([['INSERT INTO g(who) VALUES(?)', 'late one']]),
      db.batchAsync([['INSERT INTO g(who) VALUES(?)', 'student 3']]), // already there
      db.batchAsync([['INSERT INTO g(who) VALUES(?)', 'late two'], ['SELECT COUNT(*) AS n FROM g']]),
      db.batchAsync([['INSERT INTO g(who, parent) VALUES(?, ?)', 'orphan', 9999]]), // a foreign key that does not exist
    ]);
    assert.deepEqual(mixed.map((m) => m.status), ['fulfilled', 'rejected', 'fulfilled', 'rejected']);
    assert.match(mixed[1].reason.message, /UNIQUE/);
    assert.match(mixed[3].reason.message, /FOREIGN KEY/);
    assert.equal(db.all("SELECT who FROM g WHERE who LIKE 'late%' ORDER BY who").length, 2);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM g WHERE who = 'orphan'").n, 0);

    // A read does not wait behind writes, and a write after a quiet moment is its own transaction.
    await sent();
    await db.batchAsync([['INSERT INTO g(who) VALUES(?)', 'alone']]);
    assert.equal((await sent()).filter((b) => b.includes('BEGIN IMMEDIATE')).length, 1);
  } finally {
    db.close();
    child.kill();
    fake.child.kill();
  }
});
