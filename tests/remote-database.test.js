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
