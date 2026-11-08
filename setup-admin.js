'use strict';
/**
 * Create the first administrator, or reset an administrator's password.
 *
 *   node --env-file=.env setup-admin.js
 *
 * Reads CAMPUS_ADMIN_EMAIL and CAMPUS_ADMIN_PASSWORD (12+ characters).
 */
const { loadConfig } = require('./src/config');
const { openDatabase } = require('./src/db/database');
const { runMigrations } = require('./src/db/migrate');
const { hashPassword } = require('./src/lib/crypto');

const config = loadConfig();
const { adminEmail, adminPassword } = config.seed;
if (!adminPassword || adminPassword.length < 12) {
  console.error('Set CAMPUS_ADMIN_PASSWORD (at least 12 characters) in .env first.');
  process.exit(1);
}

const db = openDatabase(config.dbPath);
runMigrations(db, { log: console.log });

let institution = db.get('SELECT id, name FROM institutions ORDER BY id LIMIT 1');
if (!institution) {
  const name = config.seed.institution || config.site.institution;
  institution = { id: db.insert('INSERT INTO institutions(name, slug, created) VALUES(?, ?, ?)', name, 'demo-university', new Date().toISOString()), name };
}

const email = adminEmail.toLowerCase();
db.run(
  `INSERT INTO users(institution_id, name, email, pass, role, created) VALUES(?, ?, ?, ?, 'admin', ?)
   ON CONFLICT(institution_id, email) DO UPDATE SET pass = excluded.pass, role = 'admin', failed_logins = 0, locked_until = NULL, deleted = 0`,
  institution.id, 'University Administrator', email, hashPassword(adminPassword), new Date().toISOString(),
);

if (!db.get('SELECT id FROM courses WHERE institution_id = ? LIMIT 1', institution.id)) {
  db.run('INSERT INTO courses(institution_id, title, code) VALUES(?, ?, ?)', institution.id, 'Demo course · Introduction to Digital Technology', 'DEMO101');
}

db.close();
console.log(`Administrator ready: ${email}\nInstitution: ${institution.name}`);
