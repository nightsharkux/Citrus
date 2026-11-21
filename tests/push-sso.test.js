'use strict';
/** Web Push encryption + delivery, and OpenID Connect single sign-on against a mock identity provider. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { startApp } = require('./helpers');
const { encryptPayload } = require('../src/modules/notifications/webpush');

/** Decrypt an aes128gcm Web Push body as the browser would (RFC 8291). */
function decrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  const shared = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8');
}

test('push payloads decrypt correctly and are delivered to subscribed browsers', async () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  assert.equal(decrypt(encryptPayload(sub, '{"title":"Hi"}'), ua, auth), '{"title":"Hi"}');

  const received = [];
  const pushService = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(201);
    res.end();
  });
  await new Promise((r) => pushService.listen(0, '127.0.0.1', r));
  const app = await startApp({ env: { PUSH_ALLOW_ANY_ENDPOINT: '1' } });
  try {
    await app.register('stu');
    const endpoint = `http://127.0.0.1:${pushService.address().port}/push/abc`;
    assert.equal((await app.call('stu', 'POST', '/api/push/subscribe', { endpoint, keys: sub })).status, 201);
    await app.call('stu', 'POST', '/api/push/test');
    for (let i = 0; i < 40 && !received.length; i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['content-encoding'], 'aes128gcm');
    assert.match(received[0].headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(JSON.parse(decrypt(received[0].body, ua, auth)).title, 'Notifications are working');
    assert.equal((await app.call('stu', 'GET', '/api/notifications')).body.unread, 1);
  } finally {
    await app.close();
    await new Promise((r) => pushService.close(r));
  }

  const strict = await startApp();
  try {
    await strict.register('stu');
    const bad = await strict.call('stu', 'POST', '/api/push/subscribe', { endpoint: 'http://169.254.169.254/latest', keys: sub });
    assert.equal(bad.status, 400, 'unknown push hosts are refused (no SSRF)');
  } finally {
    await strict.close();
  }
});

test('OpenID Connect login verifies the ID token and creates the account', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  let issuer = '';
  const idp = { nonce: null, claims: {} };
  const sign = (claims) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${p}.${crypto.sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
  };
  const server = http.createServer(async (req, res) => {
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (req.url === '/jwks') return json({ keys: [jwk] });
    if (req.url === '/token') {
      let raw = '';
      for await (const c of req) raw += c;
      const form = new URLSearchParams(raw);
      if (form.get('code') !== 'good-code' || !form.get('code_verifier')) { res.writeHead(400); return res.end(); }
      return json({ id_token: sign({ iss: issuer, aud: 'citrus', sub: 'u-123', exp: Math.floor(Date.now() / 1000) + 300, nonce: idp.nonce, email: 'Prof.Ada@Uni.example', name: 'Ada Lovelace', eduPersonAffiliation: ['faculty@uni.example'], ...idp.claims }) });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${server.address().port}`;
  const app = await startApp({ env: { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'citrus', OIDC_CLIENT_SECRET: 's3cret', OIDC_ROLE_CLAIM: 'eduPersonAffiliation' } });
  try {
    const boot = (await app.call('x', 'GET', '/api/bootstrap')).body;
    assert.equal(boot.sso.enabled, true);

    const start = await app.call('x', 'GET', '/auth/sso/start?return=/schedule');
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get('location'));
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    idp.nonce = authorize.searchParams.get('nonce');
    const state = authorize.searchParams.get('state');

    const cb = await app.call('x', 'GET', `/auth/sso/callback?code=good-code&state=${state}`);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/schedule');
    const me = (await app.call('x', 'GET', '/api/bootstrap')).body.user;
    assert.equal(me.email, 'prof.ada@uni.example');
    assert.equal(me.role, 'student', 'role claims are not trusted unless configured');
    assert.equal(me.requested_role, 'lecturer', 'staff affiliation becomes a lecturer request');
    assert.equal(me.auth_provider, 'oidc');

    const replay = await app.call('y', 'GET', `/auth/sso/callback?code=good-code&state=${state}`);
    assert.match(decodeURIComponent(replay.headers.get('location')), /expired/, 'state is single-use');

    const start2 = await app.call('z', 'GET', '/auth/sso/start');
    const state2 = new URL(start2.headers.get('location')).searchParams.get('state');
    idp.nonce = 'wrong-nonce';
    const bad = await app.call('z', 'GET', `/auth/sso/callback?code=good-code&state=${state2}`);
    assert.match(decodeURIComponent(bad.headers.get('location')), /nonce mismatch/);
  } finally {
    await app.close();
    await new Promise((r) => server.close(r));
  }
});
