'use strict';
/**
 * Keys that normally live in storage/ (device secret key, card HMAC key, Web Push
 * keys). A hosted database has no storage/ folder next to it, so these are kept
 * here instead. Unused when the server runs from a local file.
 */
module.exports = {
  version: 5,
  name: 'app-keys',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS app_keys(
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created TEXT NOT NULL
    )`);
  },
};
