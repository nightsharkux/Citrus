'use strict';
/**
 * Where the server's own keys live.
 *
 *  - CAMPUS_MASTER_KEY / CAMPUS_NFC_KEY (64 hex characters or base64 of 32 bytes), when set, always win.
 *    Prefer this on a hosted database: the key then stays out of the data it protects.
 *  - With a local database file, keys are files in storage/ (unchanged from earlier releases).
 *  - With a hosted database there is no storage/ folder, so keys are generated once and kept in
 *    the `app_keys` table.
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { loadKeyFile } = require('../lib/crypto');

function parseKey(value, variable) {
  const text = String(value || '').trim();
  if (!text) return null;
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error(`${variable} must be 32 bytes: 64 hex characters or base64. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`);
  return key;
}

function createKeys({ config, db, env = process.env }) {
  const hosted = !!config.database.url;

  /** Read a value from app_keys, creating it with `make()` the first time. Safe if two instances race. */
  function stored(name, make) {
    db.run('INSERT OR IGNORE INTO app_keys(name, value, created) VALUES(?, ?, ?)', name, make(), new Date().toISOString());
    return db.get('SELECT value FROM app_keys WHERE name = ?', name).value;
  }

  const random32 = () => crypto.randomBytes(32).toString('base64');

  function secretKey(name, variable) {
    const fromEnv = parseKey(env[variable], variable);
    if (fromEnv) return fromEnv;
    if (!hosted) return loadKeyFile(path.join(config.storageDir, `${name}.key`));
    return Buffer.from(stored(name, random32), 'base64');
  }

  return {
    master: () => secretKey('master', 'CAMPUS_MASTER_KEY'),
    nfc: () => secretKey('nfc-hmac', 'CAMPUS_NFC_KEY'),
    /** Web Push signing keys as { publicKey, privateKey }, or null to keep them in storage/vapid.json. */
    vapid() {
      if (!hosted) return null;
      return JSON.parse(stored('vapid', () => {
        const ecdh = crypto.createECDH('prime256v1');
        ecdh.generateKeys();
        return JSON.stringify({ publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') });
      }));
    },
  };
}

module.exports = { createKeys, parseKey };
