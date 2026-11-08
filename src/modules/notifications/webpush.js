'use strict';
/**
 * Web Push without dependencies:
 *   - VAPID (RFC 8292): ES256-signed JWT identifying this server.
 *   - Payload encryption (RFC 8291, aes128gcm content coding, RFC 8188).
 *
 * Keys are generated once and stored in storage/vapid.json, or in the database when a hosted
 * database is used (the caller then passes them in as `storedKeys`).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Well-known browser push services. Prevents the server from POSTing to arbitrary hosts. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/, /^android\.googleapis\.com$/];

function isAllowedEndpoint(endpoint, allowAny = false) {
  try {
    const url = new URL(endpoint);
    if (allowAny) return url.protocol === 'https:' || url.protocol === 'http:';
    return url.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

function loadVapidKeys(storageDir, storedKeys) {
  const file = path.join(storageDir, 'vapid.json');
  let stored = storedKeys;
  try {
    if (!stored) stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    stored = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
  }
  const pub = Buffer.from(stored.publicKey, 'base64url');
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: stored.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
  });
  return { publicKey: stored.publicKey, key };
}

function vapidAuthorization(endpoint, vapid, subject) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

/** Encrypt `payload` for one subscription (RFC 8291). */
function encryptPayload({ p256dh, auth }, payload) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body]);
}

function createPushSender({ storageDir, storedKeys, subject, fetchImpl = (...a) => fetch(...a), allowAnyEndpoint = false }) {
  const vapid = loadVapidKeys(storageDir, storedKeys);

  /** Returns 'sent' | 'gone' | 'failed'. */
  async function send(subscription, message, { ttl = 86_400, urgency = 'normal' } = {}) {
    if (!isAllowedEndpoint(subscription.endpoint, allowAnyEndpoint)) return 'gone';
    const body = encryptPayload(subscription, JSON.stringify(message));
    try {
      const response = await fetchImpl(subscription.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidAuthorization(subscription.endpoint, vapid, subject),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(ttl),
          Urgency: urgency,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404 || response.status === 410) return 'gone';
      return response.ok ? 'sent' : 'failed';
    } catch {
      return 'failed';
    }
  }

  return { publicKey: vapid.publicKey, send, isAllowedEndpoint: (e) => isAllowedEndpoint(e, allowAnyEndpoint) };
}

module.exports = { createPushSender, encryptPayload, isAllowedEndpoint };
