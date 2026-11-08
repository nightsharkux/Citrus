'use strict';
/**
 * Cryptographic helpers. Everything uses node:crypto — no third-party code.
 *
 *  - Passwords: scrypt with a per-user salt (format "salt:hash", compatible with 0.x).
 *  - Tokens: 32 random bytes; only the SHA-256 digest is stored.
 *  - Secrets at rest (device keys, connector tokens): AES-256-GCM with a
 *    master key kept in storage/master.key (back it up with the database).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hex] = String(stored).split(':');
    const expected = Buffer.from(hex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, 64);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Load a 32-byte key from disk, creating it on first use. */
function loadKeyFile(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
    return key;
  }
}

function createSecretBox(key) {
  return {
    seal(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
    },
    open(sealed) {
      const [version, iv, tag, data] = String(sealed).split('.');
      if (version !== 'v1') throw new Error('Unknown secret format');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}

module.exports = { hashPassword, verifyPassword, randomToken, sha256, hmac, safeEqual, loadKeyFile, createSecretBox };
