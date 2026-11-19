'use strict';
/**
 * Online backup — safe while Citrus is running.
 *
 *   node --env-file-if-exists=.env scripts/backup.js
 *
 * Writes backups/citrus-<timestamp>/ containing a consistent database
 * snapshot (SQLite VACUUM INTO), the audio recordings and the key files.
 * Keeps the newest BACKUP_KEEP backups (default 14). Copy the backups folder
 * off the server too — a backup on the same disk is not a backup.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig, ROOT } = require('../src/config');

const config = loadConfig();

if (config.database.url) {
  console.error('The database is hosted (TURSO_DATABASE_URL is set), so there is no local file to copy.');
  console.error('Back it up from Turso: "turso db shell <name> .dump > citrus.sql". Turso also keeps point-in-time restore points.');
  console.error('Keep CAMPUS_MASTER_KEY and CAMPUS_NFC_KEY (or the app_keys table) with that dump: without them, device secrets and Moodle tokens cannot be read.');
  process.exit(1);
}
const backupRoot = path.resolve(process.env.BACKUP_DIR || path.join(ROOT, 'backups'));
const keep = Math.max(1, Number.parseInt(process.env.BACKUP_KEEP || '14', 10) || 14);

if (!fs.existsSync(config.dbPath)) {
  console.error(`No database at ${config.dbPath}. Nothing to back up.`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(backupRoot, `citrus-${stamp}`);
fs.mkdirSync(target, { recursive: true, mode: 0o700 });

// 1. Consistent database snapshot, even with the server writing.
const snapshot = path.join(target, path.basename(config.dbPath));
const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
db.close();

// 2. Recordings and keys (without the keys, device secrets, Moodle tokens and card links are unreadable).
if (fs.existsSync(config.audioDir)) fs.cpSync(config.audioDir, path.join(target, 'audio'), { recursive: true });
for (const file of ['master.key', 'nfc-hmac.key', 'vapid.json']) {
  const source = path.join(config.storageDir, file);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(target, file));
}

// 3. Retention: only touches folders this script created.
const old = fs.readdirSync(backupRoot).filter((name) => /^(?:citrus|campusos)-\d{4}-/.test(name)).sort().reverse().slice(keep);
for (const name of old) fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });

console.log(`Backup saved: ${target}${old.length ? ` (removed ${old.length} older)` : ''}`);
console.log('To restore: stop Citrus, copy these files into the storage folder, start Citrus.');
