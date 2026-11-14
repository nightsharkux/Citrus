'use strict';
/**
 * File storage on Vercel Blob, spoken to directly over HTTP (no SDK), for course files and recordings that do not
 * fit in the database or in one request to the hosting (4.5 MB).
 *
 * It switches on by itself when the project has a Blob store connected: Vercel then sets BLOB_READ_WRITE_TOKEN.
 * Without it everything keeps working as before (small files in the database, recordings on the phone).
 *
 * Files are private: nobody can open them by their address. Uploads go straight from the browser to Blob with a
 * short-lived upload pass that only allows one exact path, one size and the given types (so big files never pass
 * through a function); downloads are streamed through Campus OS after it has checked who is asking.
 *
 * VERCEL_BLOB_API_URL points it at a stand-in store for tests, as in Vercel's own SDK.
 */
const crypto = require('node:crypto');

const DEFAULT_API = 'https://vercel.com/api/blob';
const API_VERSION = '13';

function createBlobStore({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const token = String(env.BLOB_READ_WRITE_TOKEN || '').trim();
  const storeId = token.split('_')[3] || '';
  const api = String(env.VERCEL_BLOB_API_URL || DEFAULT_API).replace(/\/+$/, '');
  const override = env.VERCEL_BLOB_API_URL ? new URL(api).origin : null;
  const enabled = !!(token && storeId);

  const headers = (extra = {}) => ({ authorization: `Bearer ${token}`, 'x-api-version': API_VERSION, ...extra });

  async function failure(res, what) {
    let message = '';
    try {
      message = (await res.json())?.error?.message || '';
    } catch {
      /* not JSON */
    }
    const error = new Error(`File storage could not ${what}${message ? `: ${message}` : ''} (${res.status})`);
    error.status = res.status === 404 ? 404 : 502;
    return error;
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
    if (!owns(url)) throw Object.assign(new Error('Not a stored file'), { status: 400 });
    const ask = /^bytes=\d*-\d*$/.test(String(range)) ? { range: String(range) } : {};
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, ...ask } });
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

  /**
   * A pass that lets the browser upload one file straight to the store: only this path, at most this size, only
   * these types, for a few minutes. Signed with the store's token the same way Vercel's SDK does it.
   */
  function uploadPass({ pathname, maximumSizeInBytes, allowedContentTypes, minutes = 10 }) {
    const payload = Buffer.from(JSON.stringify({
      pathname, maximumSizeInBytes, allowedContentTypes, addRandomSuffix: false, allowOverwrite: false, validUntil: Date.now() + minutes * 60_000,
    })).toString('base64');
    const signature = crypto.createHmac('sha256', token).update(payload).digest('hex');
    return {
      token: `vercel_blob_client_${storeId}_${Buffer.from(`${signature}.${payload}`).toString('base64')}`,
      url: `${api}/?${new URLSearchParams({ pathname })}`,
      headers: { 'x-api-version': API_VERSION, 'x-vercel-blob-access': 'private', 'x-add-random-suffix': '0', 'x-allow-overwrite': '0' },
    };
  }

  /** Where a path we issued ends up, for checking what the browser says it uploaded. */
  const urlOf = (pathname) => (override ? `${override}/${pathname}` : `https://${storeId}.private.blob.vercel-storage.com/${pathname}`);

  /**
   * A receipt for an upload we allowed: the browser hands it back when it is done, so the server knows the path
   * was its own (and for which course or space and person) without a table of pending uploads.
   */
  function ticket(data, minutes = 60) {
    const body = Buffer.from(JSON.stringify({ ...data, until: Date.now() + minutes * 60_000 })).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', `${token}:campus-ticket`).update(body).digest('base64url')}`;
  }

  function readTicket(value) {
    const [body, mac] = String(value || '').split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', `${token}:campus-ticket`).update(body).digest('base64url');
    if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return data.until > Date.now() ? data : null;
    } catch {
      return null;
    }
  }

  /** The origin the browser uploads to, for the page's Content-Security-Policy. */
  const uploadOrigin = () => new URL(api).origin;

  return { enabled, owns, put, get, read, del, uploadPass, urlOf, ticket, readTicket, uploadOrigin };
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

module.exports = { createBlobStore, pipeTo, send, safeName };
