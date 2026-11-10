'use strict';
/**
 * Serves /public with ETags, and falls back to the single-page app shell for
 * in-app routes like /courses/12. The shell is templated with edition data so
 * the right colours appear before any JavaScript runs.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

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

/**
 * Versioned URLs, with no build step. The version is a short hash of every script, style and page file. The server
 * adds it to each script, style and import URL it serves (`/js/app.js?v=3fa9…`) and serves those URLs as cacheable
 * for a year, so a browser downloads each file once and never asks about it again. After a deploy the hash changes,
 * every URL changes with it, and browsers fetch the new files exactly once. Without this every page load asked the
 * server about ~35 files, which costs nothing on localhost and a full round trip each over the internet.
 */
const IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"?\s]+?\.js)\2/g;
const withVersion = (source, version) => source.replace(IMPORT, (m, lead, quote, spec) => `${lead}${quote}${spec}?v=${version}${quote}`);

function createStaticServer({ publicDir, site }) {
  const root = path.resolve(publicDir);
  let shellCache = null;
  let versionMemo = { at: 0, value: '0' };

  /** The current version. Checked at most every two seconds (about a hundred stat calls), so edits show up without a restart. */
  function version() {
    const now = Date.now();
    if (now - versionMemo.at < 2000) return versionMemo.value;
    const hash = crypto.createHash('sha1');
    try {
      for (const name of fs.readdirSync(root, { recursive: true }).sort()) {
        if (!/\.(js|css|html)$/.test(name)) continue;
        const stat = fs.statSync(path.join(root, name));
        hash.update(`${name}:${stat.size}:${Math.floor(stat.mtimeMs)};`);
      }
    } catch { /* a file vanished mid-scan: the next check will see it */ }
    versionMemo = { at: now, value: hash.digest('hex').slice(0, 10) };
    return versionMemo.value;
  }

  /** Script and style files of the app shell get the version too; everything else (icons, manifest) is left alone. */
  const stampShell = (html, v) => html.replace(/(href|src)="(\/(?:js|css)\/[^"?]+)"/g, (m, attr, url) => `${attr}="${url}?v=${v}"`);

  const rewrites = new Map();
  function rewrittenScript(filePath, v) {
    const key = `${filePath}:${v}`;
    let out = rewrites.get(key);
    if (!out) {
      out = Buffer.from(withVersion(fs.readFileSync(filePath, 'utf8'), v));
      rewrites.set(key, out);
      if (rewrites.size > 400) rewrites.delete(rewrites.keys().next().value);
    }
    return out;
  }

  function renderShell() {
    const file = path.join(root, 'index.html');
    const stat = fs.statSync(file);
    const v = version();
    if (shellCache && shellCache.mtime === stat.mtimeMs && shellCache.v === v) return shellCache.body;
    const body = stampShell(fs
      .readFileSync(file, 'utf8')
      .replaceAll('{{EDITION}}', site.id)
      .replaceAll('{{TITLE}}', escapeHtml(site.name))
      .replaceAll('{{ACCENT}}', site.palette.accent)
      .replaceAll('{{VERSION}}', site.version), v);
    shellCache = { mtime: stat.mtimeMs, v, body };
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
    const out = compress(`shell:${shellCache.mtime}:${shellCache.v}:${encoding}`, body, encoding);
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
    const script = ext === '.js';
    const v = script ? version() : '';
    // A URL with ?v=<hash> never changes content, so browsers may keep it for a year; others are checked each time.
    const immutable = (script || ext === '.css') && /[?&]v=[0-9a-f]{6,}/.test(req.url || '');
    // Small text files are sent compressed; the ETag names the encoding so caches never mix them up.
    const encoding = COMPRESSIBLE.has(ext) && stat.size > 600 && stat.size < 4_000_000 ? encodingFor(req) : null;
    const fileVersion = `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${v ? `-${v}` : ''}`;
    const etag = `W/"${fileVersion}${encoding ? `-${encoding}` : ''}"`;
    const headers = { 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', ETag: etag, ...(COMPRESSIBLE.has(ext) ? { Vary: 'Accept-Encoding' } : {}) };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const type = TYPES[ext] || 'application/octet-stream';
    if (script || encoding) {
      const body = script ? rewrittenScript(filePath, v) : fs.readFileSync(filePath);
      const out = encoding ? compress(`${filePath}:${fileVersion}:${encoding}`, body, encoding) : body;
      res.writeHead(200, { ...headers, 'Content-Type': type, ...(encoding ? { 'Content-Encoding': encoding } : {}), 'Content-Length': out.length });
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
