'use strict';
/**
 * Citrus device protocol v1 — request signing.
 *
 * Every device request carries four headers:
 *   X-Device-Id         "dev_<number>" as shown when the device was registered
 *   X-Device-Timestamp  Unix time in milliseconds
 *   X-Device-Nonce      Random string, 16–64 chars, never reused
 *   X-Device-Signature  hex HMAC-SHA256(secret, canonical)
 *
 * canonical = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA-256(body))
 *
 * PATH is the request path without the query string, e.g. /api/v1/device/heartbeat.
 * The server rejects timestamps more than 120 s off and any repeated nonce.
 *
 * This file has no app dependencies so firmware tooling and the simulator can reuse it.
 */
const crypto = require('node:crypto');

const MAX_SKEW_MS = 120_000;

function canonical({ method, path, timestamp, nonce, body }) {
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  return [String(method).toUpperCase(), path, String(timestamp), nonce, bodyHash].join('\n');
}

function sign(secret, parts) {
  return crypto.createHmac('sha256', secret).update(canonical(parts)).digest('hex');
}

/** Headers for a signed request. `body` must be the exact string you send. */
function signedHeaders({ deviceId, secret, method, path, body = '' }) {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  return {
    'Content-Type': 'application/json',
    'X-Device-Id': deviceId,
    'X-Device-Timestamp': String(timestamp),
    'X-Device-Nonce': nonce,
    'X-Device-Signature': sign(secret, { method, path, timestamp, nonce, body }),
  };
}

function verify(secret, { method, path, timestamp, nonce, body, signature }) {
  const expected = Buffer.from(sign(secret, { method, path, timestamp, nonce, body }), 'hex');
  const given = Buffer.from(String(signature || ''), 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { canonical, sign, signedHeaders, verify, MAX_SKEW_MS };
