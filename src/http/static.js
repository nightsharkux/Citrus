'use strict';
/**
 * Serves /public with ETags, and falls back to the single-page app shell for
 * in-app routes like /courses/12. The shell is templated with edition data so
 * the right colours appear before any JavaScript runs.
 */
const fs = require('node:fs');
const path = require('node:path');

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

  function sendShell(res) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
    res.end(renderShell());
  }

  /** Returns true when the request was handled. */
  function serve(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (pathname === '/' || pathname === '/index.html') {
      sendShell(res);
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
        sendShell(res);
        return true;
      }
      return false;
    }

    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return true;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      ETag: etag,
    });
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
