'use strict';
/** Fast on a real server: scripts and styles are cached for a year under versioned URLs, and passwords hash off the main thread. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { hashPassword, hashPasswordSync, verifyPassword } = require('../src/lib/crypto');

test('the page stamps its script and style URLs and serves them as cacheable for a year', async () => {
  const app = await startApp();
  try {
    const page = await (await fetch(`${app.base}/`)).text();
    const version = /src="\/js\/main\.js\?v=([0-9a-f]{10})"/.exec(page)?.[1];
    assert.ok(version, 'main.js carries a version');
    assert.match(page, new RegExp(`href="/css/tokens\\.css\\?v=${version}"`));
    assert.match(page, new RegExp(`rel="modulepreload" href="/js/shell\\.js\\?v=${version}"`));
    assert.match(page, /href="\/icons\/[a-z]+-192\.png"/, 'pictures are left alone');

    const shell = await fetch(`${app.base}/js/shell.js?v=${version}`);
    assert.equal(shell.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const source = await shell.text();
    const imports = [...source.matchAll(/from '(\.[^']+\.js)(\?v=[0-9a-f]+)?'/g)];
    assert.ok(imports.length > 5);
    assert.ok(imports.every((m) => m[2] === `?v=${version}`), 'every import names the same version, so modules load once');
    assert.match(source, new RegExp(`import\\('\\./features/conversation\\.js\\?v=${version}'\\)`), 'dynamic imports too');

    const css = await fetch(`${app.base}/css/tokens.css?v=${version}`);
    assert.equal(css.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    // Without a version the file is still served, but the browser must check it.
    assert.equal((await fetch(`${app.base}/js/shell.js`)).headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(`${app.base}/`)).headers.get('cache-control'), 'no-cache', 'the page itself is always fresh');
    // An unchanged file is not sent again.
    const again = await fetch(`${app.base}/js/shell.js?v=${version}`, { headers: { 'if-none-match': shell.headers.get('etag') } });
    assert.equal(again.status, 304);
  } finally {
    await app.close();
  }
});

test('password hashing runs off the main thread and stays compatible with existing accounts', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(await verifyPassword('legacy password!', hashPasswordSync('legacy password!')), true, 'hashes made by the old synchronous code still verify');

  // While a hash is being computed the event loop keeps turning (the old version blocked it for the whole time).
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  await Promise.all([hashPassword('a'), hashPassword('b'), hashPassword('c')]);
  clearInterval(timer);
  assert.ok(ticks >= 3, `the event loop ran ${ticks} times during hashing`);
});
