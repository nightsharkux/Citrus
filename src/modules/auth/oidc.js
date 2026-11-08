'use strict';
/**
 * OpenID Connect single sign-on (authorization code flow + PKCE).
 *
 * Works with any standards-compliant identity provider: Keycloak, Microsoft
 * Entra ID, Google Workspace, Shibboleth IdP with the OIDC plugin, or a
 * SAML-to-OIDC bridge such as SATOSA for DFN-AAI federations.
 *
 * Configure with OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET (see .env.example).
 * The ID token signature, issuer, audience, expiry and nonce are all verified.
 */
const crypto = require('node:crypto');
const { randomToken } = require('../../lib/crypto');
const { HttpError } = require('../../http/errors');

function createOidc({ db, config, fetchImpl = (...a) => fetch(...a) }) {
  const cfg = config.oidc;
  const enabled = () => !!(cfg.issuer && cfg.clientId);
  let discovery = null;
  let jwks = null;

  async function getDiscovery() {
    if (discovery && Date.now() - discovery.at < 3_600_000) return discovery.doc;
    const res = await fetchImpl(`${cfg.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new HttpError(502, 'The university login service is unavailable');
    const doc = await res.json();
    discovery = { doc, at: Date.now() };
    return doc;
  }

  async function getKey(kid, { refresh = false } = {}) {
    if (!jwks || refresh || Date.now() - jwks.at > 3_600_000) {
      const { jwks_uri: uri } = await getDiscovery();
      const res = await fetchImpl(uri, { signal: AbortSignal.timeout(10_000) });
      jwks = { keys: (await res.json()).keys || [], at: Date.now() };
    }
    const jwk = jwks.keys.find((k) => k.kid === kid) || (jwks.keys.length === 1 && !kid ? jwks.keys[0] : null);
    if (!jwk && !refresh) return getKey(kid, { refresh: true });
    if (!jwk) throw new HttpError(401, 'Unknown signing key');
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  }

  /** Build the redirect to the identity provider. */
  async function begin(returnTo = '/home') {
    const doc = await getDiscovery();
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const safeReturn = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/home';
    db.run('INSERT INTO sso_states(state, nonce, verifier, return_to, created) VALUES(?, ?, ?, ?, ?)', state, nonce, verifier, safeReturn, Date.now());

    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      scope: cfg.scopes,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async function verifyIdToken(idToken, nonce) {
    const [h, p, s] = String(idToken).split('.');
    if (!h || !p || !s) throw new HttpError(401, 'Malformed ID token');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const algorithms = { RS256: { hash: 'sha256' }, PS256: { hash: 'sha256', padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' } };
    const alg = algorithms[header.alg];
    if (!alg) throw new HttpError(401, `Unsupported token algorithm ${header.alg}`);
    const key = await getKey(header.kid);
    const ok = crypto.verify(alg.hash, Buffer.from(`${h}.${p}`), { key, ...(alg.padding ? { padding: alg.padding } : {}), ...(alg.dsaEncoding ? { dsaEncoding: alg.dsaEncoding } : {}) }, Buffer.from(s, 'base64url'));
    if (!ok) throw new HttpError(401, 'ID token signature is invalid');

    const now = Math.floor(Date.now() / 1000);
    const audience = [].concat(claims.aud);
    if (claims.iss !== cfg.issuer) throw new HttpError(401, 'ID token issuer mismatch');
    if (!audience.includes(cfg.clientId)) throw new HttpError(401, 'ID token audience mismatch');
    if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new HttpError(401, 'ID token expired');
    if (claims.nonce !== nonce) throw new HttpError(401, 'ID token nonce mismatch');
    return claims;
  }

  /** Exchange the code, verify the ID token and return { claims, returnTo }. */
  async function complete({ code, state }) {
    const saved = db.get('SELECT * FROM sso_states WHERE state = ?', String(state || ''));
    if (!saved || Date.now() - saved.created > 10 * 60_000) throw new HttpError(400, 'Login session expired. Please try again.');
    db.run('DELETE FROM sso_states WHERE state = ?', saved.state);

    const doc = await getDiscovery();
    const res = await fetchImpl(doc.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code || ''), redirect_uri: cfg.redirectUri, code_verifier: saved.verifier }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new HttpError(401, 'The university login was not accepted');
    const tokens = await res.json();
    const claims = await verifyIdToken(tokens.id_token, saved.nonce);
    return { claims, returnTo: saved.return_to };
  }

  /** Does the configured role claim say this person is staff? */
  function claimsSayLecturer(claims) {
    if (!cfg.roleClaim) return false;
    const values = [].concat(claims[cfg.roleClaim] || []).map((v) => String(v).toLowerCase().split('@')[0]);
    return values.some((v) => cfg.lecturerValues.includes(v));
  }

  return { enabled, begin, complete, claimsSayLecturer, label: () => cfg.label };
}

module.exports = { createOidc };
