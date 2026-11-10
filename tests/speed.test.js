'use strict';
/** Loading fast: compressed text files with per-encoding ETags, and every start-up module preloaded in parallel. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { startApp } = require('./helpers');

/** Scripts are served with ?v=<hash> on their imports; removing it must give back the file exactly. */
const unstamp = (body) => Buffer.from(body.toString().replace(/\?v=[0-9a-f]{10}(?=['"])/g, ''));

/** A raw GET, so the test sees the bytes on the wire (fetch would decompress them). */
function get(base, url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('scripts and styles are sent compressed, with an ETag per encoding, and pictures as they are', async () => {
  const app = await startApp();
  try {
    const original = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shell.js'));
    const br = await get(app.base, '/js/shell.js', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(br.status, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers.vary, 'Accept-Encoding');
    assert.ok(br.body.length < original.length / 3, `${br.body.length} of ${original.length} bytes`);
    assert.deepEqual(unstamp(zlib.brotliDecompressSync(br.body)), original);

    const gz = await get(app.base, '/js/shell.js', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.deepEqual(unstamp(zlib.gunzipSync(gz.body)), original);
    assert.notEqual(gz.headers.etag, br.headers.etag, 'caches never mix encodings');

    const plain = await get(app.base, '/js/shell.js');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.deepEqual(unstamp(plain.body), original);

    const again = await get(app.base, '/js/shell.js', { 'accept-encoding': 'br', 'if-none-match': br.headers.etag });
    assert.equal(again.status, 304, 'unchanged files are not sent again');

    const shell = await get(app.base, '/assistant', { 'accept-encoding': 'br' });
    assert.equal(shell.headers['content-encoding'], 'br');
    assert.match(zlib.brotliDecompressSync(shell.body).toString(), /modulepreload/);

    const picture = await get(app.base, '/icons/general-192.png', { 'accept-encoding': 'br' });
    assert.equal(picture.status, 200);
    assert.equal(picture.headers['content-encoding'], undefined, 'PNGs are compressed already');
    assert.deepEqual(picture.body, fs.readFileSync(path.join(__dirname, '..', 'public', 'icons', 'general-192.png')));
  } finally {
    await app.close();
  }
});

test('index.html preloads every module main.js loads at start-up, and nothing that does not exist', () => {
  const root = path.join(__dirname, '..', 'public');
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|^\s*import\s+['"](\.[^'"]+)['"]/gm)) {
      walk(path.resolve(path.dirname(file), m[1] || m[2]));
    }
  };
  walk(path.join(root, 'js', 'main.js'));
  const startup = [...seen].map((f) => `/${path.relative(root, f).split(path.sep).join('/')}`).filter((f) => f !== '/js/main.js');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
  for (const file of preloaded) assert.ok(fs.existsSync(path.join(root, file)), `preloaded file is missing: ${file}`);
  const missing = startup.filter((f) => !preloaded.includes(f));
  assert.deepEqual(missing, [], `add <link rel="modulepreload" href="..."> to public/index.html for: ${missing.join(', ')}`);
});
