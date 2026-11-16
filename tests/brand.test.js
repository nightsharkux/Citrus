'use strict';
/** The platform is called Citrus; its mark is a C. The old name must not show up anywhere people can see it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startApp } = require('./helpers');

const root = path.join(__dirname, '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('the old name does not appear in the app, its texts, its AI instructions or its German translations', () => {
  const files = [...walk(path.join(root, 'public')), ...walk(path.join(root, 'src')), ...walk(path.join(root, 'config')), path.join(root, 'server.js')]
    .filter((f) => /\.(js|css|html|json|svg|webmanifest)$/.test(f));
  assert.ok(files.length > 100);
  const found = files.filter((f) => /Campus OS|Campus-OS/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.deepEqual(found, []);
});

test('the site, its manifest and its mark say Citrus, and the mark is a C', async () => {
  const app = await startApp();
  try {
    const boot = await app.call('anon', 'GET', '/api/bootstrap');
    assert.match(boot.body.site.name, /^Citrus/);
    assert.equal(boot.body.site.shortName, 'Citrus');
    const manifest = await app.call('anon', 'GET', '/manifest.webmanifest');
    assert.match(manifest.body.name, /Citrus/);
    assert.doesNotMatch(JSON.stringify(manifest.body), /Campus OS/);
    const mark = await (await fetch(`${app.base}/brand/mark.svg`)).text();
    assert.match(mark, /<title>Citrus<\/title>/);
    assert.match(mark, /stroke-linecap="round"/, 'a C with round ends, not a closed ring');
    assert.doesNotMatch(mark, /<circle/);
    const page = await (await fetch(`${app.base}/`)).text();
    assert.doesNotMatch(page, /Campus OS/);
  } finally {
    await app.close();
  }
});

test('the wordmark is a gradient C followed by "itrus", and screen readers hear Citrus', async () => {
  const { wordmark, ringMark } = await import(pathToFileURL(path.join(root, 'public', 'js', 'core', 'brand.js')).href);
  const mark = String(wordmark());
  assert.match(mark, /aria-label="Citrus"/);
  assert.match(mark, /class="wordmark-c"/);
  assert.match(mark, />itrus</);
  assert.match(String(ringMark(40)), /class="ring-mark"/);
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'face.css'), 'utf8');
  assert.match(css, /--c-mask:/, 'the C shape the marks are cut from');
  assert.match(css, /\.wordmark-c\s*\{/);
  assert.doesNotMatch(css, /wordmark-o/);
});

test('the app icons are the new C: four pictures, each a dark tile', () => {
  for (const edition of ['general', 'oth']) {
    for (const size of [192, 512]) {
      const png = fs.readFileSync(path.join(root, 'public', 'icons', `${edition}-${size}.png`));
      assert.equal(png.readUInt32BE(16), size, `${edition}-${size} width`);
      assert.equal(png.readUInt32BE(20), size, `${edition}-${size} height`);
    }
  }
});

test('the assistant is called Citrus by default, in the interface, its instructions and its voice', async () => {
  const app = await startApp();
  try {
    const boot = await app.call('anon', 'GET', '/api/bootstrap');
    assert.equal(boot.body.site.assistant, 'Citrus');
    await app.register('stu');
    assert.equal((await app.call('stu', 'GET', '/api/assistant')).body.name, 'Citrus');
    // A name chosen in the settings is kept, and going back to the default gives Citrus again.
    await app.call('stu', 'PATCH', '/api/me', { preferences: { assistantName: 'Luna' } });
    assert.equal((await app.call('stu', 'GET', '/api/assistant')).body.name, 'Luna');
    await app.call('stu', 'PATCH', '/api/me', { preferences: { assistantName: '' } });
    assert.equal((await app.call('stu', 'GET', '/api/assistant')).body.name, 'Citrus');
  } finally {
    await app.close();
  }
  const { assistantPrompt } = require('../src/ai/prompts');
  const prompt = assistantPrompt({ site: { assistant: 'Citrus' }, user: { institution: 'Test University', name: 'Ann Test', preferences: {} }, assistantName: 'Citrus', context: '', sources: [] });
  assert.match(String(prompt), /You are Citrus, the academic assistant built into Citrus/);
});

test('no text still calls the assistant Campus ("Ask Campus", "Hey Campus", "Campus explains"); the campus itself keeps its word', () => {
  const files = [...walk(path.join(root, 'public')), ...walk(path.join(root, 'src')), ...walk(path.join(root, 'config')), path.join(root, 'server.js')]
    .filter((f) => /\.(js|css|html)$/.test(f));
  const asAssistant = /\b(?:Ask|Hey|Talk to|Tell) Campus\b|\bCampus (?:is|can|will|reads|writes|explains|listens|knows|keeps|could|would|says|hears|answers)\b/;
  const found = files.filter((f) => asAssistant.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.deepEqual(found, []);
  // ...while the place is still the place.
  const nav = fs.readFileSync(path.join(root, 'public', 'js', 'nav.js'), 'utf8');
  assert.match(nav, /Campus life/);
  assert.match(nav, /Campus map/);
});
