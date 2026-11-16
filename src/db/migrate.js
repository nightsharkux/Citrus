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
  // Only a new database gets the table: a write on every start of every server instance was slow on a hosted
  // database, and waited behind any other instance that was writing.
  if (!db.hasTable('schema_migrations')) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
  }

  const applied = new Set(db.all('SELECT version FROM schema_migrations').map((r) => r.version));
  const pending = migrations.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    try {
      // Table rebuilds need foreign key checks off, which cannot be toggled inside a transaction.
      db.transaction(() => {
        migration.up(db);
        db.run('INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)', migration.version, migration.name, new Date().toISOString());
      }, { foreignKeys: false });
    } catch (error) {
      // Another server instance may have applied it a moment ago (two cold starts after a deploy).
      if (!db.get('SELECT 1 FROM schema_migrations WHERE version = ?', migration.version)) throw error;
      continue;
    }
    log(`Applied migration ${String(migration.version).padStart(3, '0')} ${migration.name}`);
  }
  return pending.length;
}

module.exports = { runMigrations };
