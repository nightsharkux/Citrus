'use strict';
/**
 * Database access. Two backends share one small synchronous API
 * (`get`, `all`, `run`, `insert`, `exec`, `transaction`, `columns`, `hasTable`):
 *
 *  - a local SQLite file via Node's built-in driver (default, and what the tests use);
 *  - a hosted database (Turso / libSQL) over HTTP, selected by TURSO_DATABASE_URL
 *    and needed on hosts without a persistent disk such as Vercel. See ./remote.js.
 *
 * `openDatabase(file)` opens a local file. `openConfiguredDatabase(config)` picks
 * the backend from the configuration.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { addIntrospection } = require('./introspection');

function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  return withHelpers(db);
}

/** The hosted database when one is configured, otherwise the local file. */
function openConfiguredDatabase(config) {
  if (config.database?.url) return require('./remote').openRemoteDatabase(config.database);
  return openDatabase(config.dbPath);
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

  /**
   * Run `fn` inside a transaction; rolls back if it throws. Nested calls join the
   * outer transaction. `{ foreignKeys: false }` switches foreign key checks off for
   * the duration, which table rebuilds in migrations need.
   */
  let depth = 0;
  db.transaction = (fn, { foreignKeys = true } = {}) => {
    if (depth > 0) return fn();
    depth += 1;
    if (!foreignKeys) db.exec('PRAGMA foreign_keys = OFF');
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
      if (!foreignKeys) db.exec('PRAGMA foreign_keys = ON');
    }
  };

  return addIntrospection(db);
}

module.exports = { openDatabase, openConfiguredDatabase, withHelpers };
