'use strict';
/** The database was called campusos.db; Citrus renames it to citrus.db, once, without losing anything. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { carryOverOldDatabaseName } = require('../src/config');

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'citrus-dbname-'));

test('an old campusos.db becomes citrus.db with its -wal and -shm files, content untouched', () => {
  const dir = folder();
  try {
    fs.writeFileSync(path.join(dir, 'campusos.db'), 'data');
    fs.writeFileSync(path.join(dir, 'campusos.db-wal'), 'wal');
    fs.writeFileSync(path.join(dir, 'campusos.db-shm'), 'shm');
    carryOverOldDatabaseName(dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['citrus.db', 'citrus.db-shm', 'citrus.db-wal']);
    assert.equal(fs.readFileSync(path.join(dir, 'citrus.db'), 'utf8'), 'data');
    carryOverOldDatabaseName(dir); // a second start changes nothing
    assert.equal(fs.readFileSync(path.join(dir, 'citrus.db'), 'utf8'), 'data');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing citrus.db is never replaced, and a folder with neither is left alone', () => {
  const dir = folder();
  try {
    fs.writeFileSync(path.join(dir, 'campusos.db'), 'old');
    fs.writeFileSync(path.join(dir, 'citrus.db'), 'new');
    carryOverOldDatabaseName(dir);
    assert.equal(fs.readFileSync(path.join(dir, 'citrus.db'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(dir, 'campusos.db'), 'utf8'), 'old', 'the old one is kept, not deleted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const empty = folder();
  try {
    carryOverOldDatabaseName(empty);
    carryOverOldDatabaseName(path.join(empty, 'missing'));
    assert.deepEqual(fs.readdirSync(empty), []);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
