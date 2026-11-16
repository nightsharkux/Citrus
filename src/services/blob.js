'use strict';
/**
 * File storage on Vercel Blob, spoken to directly over HTTP (no SDK), for course files and recordings that do not
 * fit in the database or in one request to the hosting (4.5 MB).
 *
 * It switches on by itself when the project has a Blob store connected. Vercel then sets either BLOB_STORE_ID
 * (stores made since 2026: Citrus signs in with the short-lived OIDC token Vercel gives each request) or
 * BLOB_READ_WRITE_TOKEN (older stores). Without either, everything keeps working as before (small files in the
 * database, recordings on the phone).
 *
 * Files are private: nobody can open them by their address. Uploads go straight from the browser to Blob with a
 * short-lived pass that only allows one exact path, one size and the given types (so big files never pass through
 * a function): a presigned address for OIDC stores, a client token for older ones, both made the way Vercel's SDK
 * makes them. Downloads are streamed through Citrus after it has checked who is asking.
 *
 * VERCEL_BLOB_API_URL points it at a stand-in store for tests, as in Vercel's own SDK.
 */
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { HttpError } = require('../http/errors');

const DEFAULT_API = 'https://vercel.com/api/blob';
const API_VERSION = '13';

/** The request being handled, so the OIDC token Vercel sends with it can sign this request's storage calls. */
const requestScope = new AsyncLocalStorage();
const withRequest = (req, fn) => requestScope.run(req, fn);

const normalizeStoreId = (id) => (String(id || '').startsWith('store_') ? String(id).slice('store_'.length) : String(id || ''));

function createBlobStore({ env = process.env, fetchImpl = globalThis.fetch, secret = null } = {}) {
  const rwToken = String(env.BLOB_READ_WRITE_TOKEN || '').trim();
  const oidcStore = normalizeStoreId(String(env.BLOB_STORE_ID || '').trim());
  const storeId = oidcStore || rwToken.split('_')[3] || '';
  const api = String(env.VERCEL_BLOB_API_URL || DEFAULT_API).replace(/\/+$/, '');
  const override = env.VERCEL_BLOB_API_URL ? new URL(api).origin : null;
  const enabled = !!storeId && !!(oidcStore || rwToken);
  const onVercel = !!env.VERCEL || !!override;
  const ticketKey = crypto.createHmac('sha256', secret || rwToken || 'campus-os').update('campus-blob-ticket').digest();

  /** The OIDC token of this request (Vercel adds it to every request when the project uses OIDC). */
  function oidcToken() {
    if (!onVercel) return '';
    const fromRequest = requestScope.getStore()?.headers?.['x-vercel-oidc-token'];
    const fromContext = globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.headers?.['x-vercel-oidc-token'];
    return String(fromRequest || fromContext || env.VERCEL_OIDC_TOKEN || '').trim();
  }

  /** How to sign in for this call, like the SDK: OIDC first (with a store id), else the read-write token. */
  function auth() {
    const oidc = oidcStore ? oidcToken() : '';
    if (oidc) return { kind: 'oidc', token: oidc };
    if (rwToken) return { kind: 'readWrite', token: rwToken };
    throw new HttpError(503, 'File storage is connected, but this request has no OIDC token from Vercel. Turn on OIDC for the project (Settings → Security) and redeploy.');
  }

  const headers = (extra = {}) => ({ authorization: `Bearer ${auth().token}`, 'x-api-version': API_VERSION, 'x-vercel-blob-store-id': storeId, ...extra });

  async function failure(res, what) {
    let message = '';
    try {
      message = (await res.json())?.error?.message || '';
    } catch {
      /* not JSON */
    }
    // Shown to the person as it is, so a problem with the store says what went wrong.
    return new HttpError(res.status === 404 ? 404 : 502, `File storage could not ${what}${message ? `: ${message}` : ''} (${res.status})`);
  }

  /** Is this address one of our store's files? Never fetch anything else with the token. */
  function owns(url) {
    let u;
    try {
      u = new URL(String(url));
    } catch {
      return false;
    }
    if (override && u.origin === override) return true;
    return u.protocol === 'https:' && u.hostname === `${storeId.toLowerCase()}.private.blob.vercel-storage.com`;
  }

  /** Save a file the server already has (small: an audio piece). → { url, pathname } */
  async function put(pathname, body, { contentType = 'application/octet-stream' } = {}) {
    const res = await fetchImpl(`${api}/?${new URLSearchParams({ pathname })}`, {
      method: 'PUT',
      headers: headers({ 'x-vercel-blob-access': 'private', 'x-content-type': contentType, 'x-add-random-suffix': '0', 'x-allow-overwrite': '0' }),
      body,
    });
    if (!res.ok) throw await failure(res, 'save the file');
    const out = await res.json();
    return { url: out.url, pathname: out.pathname || pathname };
  }

  /** The file as a fetch Response (streamed), or null when it is gone. `range` asks for part of it (for seeking). */
  async function get(url, { range = '' } = {}) {
    if (!owns(url)) throw new HttpError(400, 'Not a stored file');
    const ask = /^bytes=\d*-\d*$/.test(String(range)) ? { range: String(range) } : {};
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${auth().token}`, ...ask } });
    if (res.status === 404) return null;
    if (!res.ok) throw await failure(res, 'read the file');
    return res;
  }

  /** The whole file in memory (for reading its text), at most `limit` bytes; null when larger or gone. */
  async function read(url, limit) {
    const res = await get(url);
    if (!res) return null;
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > limit) {
      await res.body?.cancel?.();
      return null;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > limit) return null;
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async function del(urls) {
    const list = [].concat(urls).filter((u) => owns(u));
    if (!list.length) return;
    const res = await fetchImpl(`${api}/delete`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ urls: list }) });
    if (!res.ok && res.status !== 404) throw await failure(res, 'delete the file');
  }

  // What the browser sends with its upload: only headers Vercel Blob allows from another site (its CORS preflight
  // lists them). Anything else and the browser refuses to send the file at all ("The upload was interrupted").
  // No random suffix and no overwriting are part of the pass itself (token payload or signed address).
  const putHeaders = { 'x-api-version': API_VERSION, 'x-vercel-blob-store-id': storeId, 'x-vercel-blob-access': 'private' };

  /**
   * A pass that lets the browser upload one file straight to the store: only this path, at most this size, only
   * these types, for a few minutes. → { url, headers, token? } (send `authorization: Bearer token` when given).
   */
  async function uploadPass({ pathname, maximumSizeInBytes, allowedContentTypes, minutes = 10 }) {
    const validUntil = Date.now() + minutes * 60_000;
    const a = auth();
    if (a.kind === 'readWrite') {
      // Older stores: a client token, HMAC-signed with the read-write token.
      const payload = Buffer.from(JSON.stringify({ pathname, maximumSizeInBytes, allowedContentTypes, addRandomSuffix: false, allowOverwrite: false, validUntil })).toString('base64');
      const signature = crypto.createHmac('sha256', a.token).update(payload).digest('hex');
      return {
        token: `vercel_blob_client_${storeId}_${Buffer.from(`${signature}.${payload}`).toString('base64')}`,
        url: `${api}/?${new URLSearchParams({ pathname })}`,
        headers: putHeaders,
      };
    }
    // OIDC stores: Blob issues a delegation for this one path; we sign the address with its client signing key, which
    // never leaves the server. The browser only gets the signed address.
    const res = await fetchImpl(`${api}/signed-token`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ pathname, operations: ['put'], validUntil, maximumSizeInBytes, allowedContentTypes }),
    });
    if (!res.ok) throw await failure(res, 'prepare the upload');
    const signed = await res.json();
    const params = [
      ['vercel-blob-add-random-suffix', 'false'],
      ['vercel-blob-allow-overwrite', 'false'],
      ['vercel-blob-allowed-content-types', [...allowedContentTypes].sort().join(',')],
      ['vercel-blob-maximum-size-in-bytes', String(Math.trunc(maximumSizeInBytes))],
    ];
    return { url: presignedPutUrl({ pathname, params, delegationToken: signed.delegationToken, clientSigningToken: signed.clientSigningToken }), headers: putHeaders };
  }

  /** The SDK's presigned address: the canonical lines sorted by their UTF-8 bytes, HMAC-SHA256, base64url. */
  function presignedPutUrl({ pathname, params, delegationToken, clientSigningToken }) {
    const lines = ['operation=put', `pathname=${pathname}`, ...params.filter(([, v]) => v).map(([k, v]) => `${k}=${v}`)]
      .sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    const signature = crypto.createHmac('sha256', clientSigningToken).update(lines.join('\n')).digest('base64url');
    const url = new URL(`${api}/?${new URLSearchParams({ pathname })}`);
    for (const [k, v] of params) url.searchParams.set(k, v);
    url.searchParams.set('vercel-blob-delegation', delegationToken);
    url.searchParams.set('vercel-blob-signature', signature);
    return url.toString();
  }

  /** Where a path we issued ends up, for checking what the browser says it uploaded. */
  const urlOf = (pathname) => (override ? `${override}/${pathname}` : `https://${storeId.toLowerCase()}.private.blob.vercel-storage.com/${pathname}`);

  /**
   * A receipt for an upload we allowed: the browser hands it back when it is done, so the server knows the path
   * was its own (and for which course or space and person) without a table of pending uploads.
   */
  function ticket(data, minutes = 60) {
    const body = Buffer.from(JSON.stringify({ ...data, until: Date.now() + minutes * 60_000 })).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', ticketKey).update(body).digest('base64url')}`;
  }

  function readTicket(value) {
    const [body, mac] = String(value || '').split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', ticketKey).update(body).digest('base64url');
    if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return data.until > Date.now() ? data : null;
    } catch {
      return null;
    }
  }

  return { enabled, mode: oidcStore ? 'oidc' : rwToken ? 'readWrite' : null, owns, put, get, read, del, uploadPass, presignedPutUrl, urlOf, ticket, readTicket };
}

/** Write one piece to the visitor, waiting when they are slow. False once they have gone. */
async function send(res, chunk) {
  if (res.destroyed) return false;
  if (!res.write(chunk)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
  return !res.destroyed;
}

/** Stream a stored file to the visitor (streamed responses have no size limit on the hosting). */
async function pipeTo(res, upstream, { end = true } = {}) {
  for await (const chunk of upstream.body) {
    if (!(await send(res, chunk))) {
      await upstream.body.cancel?.().catch(() => {});
      return false;
    }
  }
  if (end) res.end();
  return true;
}

/** A safe last part of a path in the store. */
const safeName = (name) => String(name || 'file').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'file';

module.exports = { createBlobStore, withRequest, pipeTo, send, safeName };
