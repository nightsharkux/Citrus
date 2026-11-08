'use strict';
/**
 * Numbered, transactional schema migrations.
 *
 * Each file in ./migrations exports { version, name, up(db) }. Applied versions
 * are recorded in `schema_migrations`. Migrations must be additive so that a
 * database from an older release upgrades in place without data loss.
 */
const migrations = require('./migrations');

function runMigrations(db, { log = () => {} } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(db.all('SELECT version FROM schema_migrations').map((r) => r.version));
  const pending = migrations.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    // Table rebuilds need foreign keys off; it cannot be toggled inside a transaction.
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        migration.up(db);
        db.run('INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)', migration.version, migration.name, new Date().toISOString());
      });
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
    log(`Applied migration ${String(migration.version).padStart(3, '0')} ${migration.name}`);
  }
  return pending.length;
}

module.exports = { runMigrations };
