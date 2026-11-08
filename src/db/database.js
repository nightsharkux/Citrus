'use strict';
/**
 * SQLite access via Node's built-in driver. `openDatabase` returns the raw
 * DatabaseSync handle with a few small helpers attached so modules can write
 * `db.get(sql, ...args)` instead of `db.prepare(sql).get(...args)`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  return withHelpers(db);
}

function withHelpers(db) {
  const cache = new Map();
  const prepare = (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      if (cache.size > 500) cache.clear();
      cache.set(sql, stmt);
    }
    return stmt;
  };

  db.get = (sql, ...args) => prepare(sql).get(...args);
  db.all = (sql, ...args) => prepare(sql).all(...args);
  db.run = (sql, ...args) => prepare(sql).run(...args);
  db.insert = (sql, ...args) => Number(prepare(sql).run(...args).lastInsertRowid);

  /** Run `fn` inside a transaction; rolls back if it throws. Nested calls join the outer transaction. */
  let depth = 0;
  db.transaction = (fn) => {
    if (depth > 0) return fn();
    depth += 1;
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      depth -= 1;
    }
  };

  db.columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  db.hasTable = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return db;
}

module.exports = { openDatabase, withHelpers };
