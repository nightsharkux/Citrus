'use strict';
/**
 * Serves /public with ETags, and falls back to the single-page app shell for
 * in-app routes like /courses/12. The shell is templated with edition data so
 * the right colours appear before any JavaScript runs.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** Text files shrink four to six times; pictures and fonts are compressed already. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.webmanifest', '.txt']);

/** The best encoding the browser accepts: br, gzip or none. */
function encodingFor(req) {
  const accepted = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}

/** Compressed copies, made once per file version and encoding. */
const compressed = new Map();
function compress(key, body, encoding) {
  const hit = compressed.get(key);
  if (hit) return hit;
  const out = encoding === 'br'
    ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 7, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
    : zlib.gzipSync(body, { level: 7 });
  compressed.set(key, out);
  if (compressed.size > 600) compressed.delete(compressed.keys().next().value);
  return out;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function createStaticServer({ publicDir, site }) {
  const root = path.resolve(publicDir);
  let shellCache = null;

  function renderShell() {
    const file = path.join(root, 'index.html');
    const stat = fs.statSync(file);
    if (shellCache && shellCache.mtime === stat.mtimeMs) return shellCache.body;
    const body = fs
      .readFileSync(file, 'utf8')
      .replaceAll('{{EDITION}}', site.id)
      .replaceAll('{{TITLE}}', escapeHtml(site.name))
      .replaceAll('{{ACCENT}}', site.palette.accent)
      .replaceAll('{{VERSION}}', site.version);
    shellCache = { mtime: stat.mtimeMs, body };
    return body;
  }

  function sendShell(req, res) {
    const body = Buffer.from(renderShell());
    const encoding = encodingFor(req);
    const headers = { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (!encoding) {
      res.writeHead(200, headers);
      res.end(body);
      return;
    }
    const out = compress(`shell:${shellCache.mtime}:${encoding}`, body, encoding);
    res.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': out.length });
    res.end(req.method === 'HEAD' ? undefined : out);
  }

  /** Returns true when the request was handled. */
  function serve(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (pathname === '/' || pathname === '/index.html') {
      sendShell(req, res);
      return true;
    }

    const filePath = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!filePath.startsWith(root + path.sep)) return false;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      stat = null;
    }

    if (!stat || !stat.isFile()) {
      // In-app route (no file extension): hand back the app shell.
      if (!path.extname(pathname)) {
        sendShell(req, res);
        return true;
      }
      return false;
    }

    const ext = path.extname(filePath).toLowerCase();
    // Small text files are sent compressed; the ETag names the encoding so caches never mix them up.
    const encoding = COMPRESSIBLE.has(ext) && stat.size > 600 && stat.size < 4_000_000 ? encodingFor(req) : null;
    const version = `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`;
    const etag = `W/"${version}${encoding ? `-${encoding}` : ''}"`;
    const headers = { 'Cache-Control': 'no-cache', ETag: etag, ...(COMPRESSIBLE.has(ext) ? { Vary: 'Accept-Encoding' } : {}) };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const type = TYPES[ext] || 'application/octet-stream';
    if (encoding) {
      const out = compress(`${filePath}:${version}:${encoding}`, fs.readFileSync(filePath), encoding);
      res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Encoding': encoding, 'Content-Length': out.length });
      res.end(req.method === 'HEAD' ? undefined : out);
      return true;
    }
    res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': stat.size });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(filePath).pipe(res);
    return true;
  }

  return { serve };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

module.exports = { createStaticServer };
