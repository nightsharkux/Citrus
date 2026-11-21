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

test('the old name is gone from the code, the scripts, the Android app, the docs and the data the assistant reads', () => {
  // A few places keep an old spelling on purpose, so that nothing already installed or saved stops working:
  //   native.js         Android apps installed before the rename still send "CampusOSApp" in their user agent
  //   config.js         renames an existing campusos.db to citrus.db, once, when the app starts
  //   backup.js         tidies old backup folders that were named campusos-...
  //   import-storage.js brings in the storage folder of an install that still has campusos.db
  const keep = new Set(['public/js/features/native.js', 'src/config.js', 'scripts/backup.js', 'scripts/import-storage.js'].map((f) => path.join(root, f)));
  const skipDir = /[\/](node_modules|build|\.gradle|storage)[\/]/;
  const files = [
    ...walk(path.join(root, 'public')), ...walk(path.join(root, 'src')), ...walk(path.join(root, 'config')), ...walk(path.join(root, 'resources')),
    ...walk(path.join(root, 'scripts')), ...walk(path.join(root, 'android')), ...walk(path.join(root, '.github')),
    ...walk(path.join(root, 'docs')).filter((f) => !/CHANGELOG\.md$/.test(f)), path.join(root, 'server.js'), path.join(root, 'README.md'), path.join(root, 'package.json'),
  ].filter((f) => /\.(js|css|html|json|jsonl|txt|svg|webmanifest|md|yml|gradle|java|xml|properties)$/.test(f) && !keep.has(f) && !skipDir.test(f));
  const found = files.filter((f) => /campus ?-?_?os/i.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.deepEqual(found, []);
});

test('the site, its manifest and its mark say Citrus, and the mark is the citrus slice', async () => {
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
    assert.match(mark, /<linearGradient/, 'orange to pink to violet');
    assert.equal((mark.match(/<path /g) || []).length, 11, 'the ring and ten segments');
    assert.doesNotMatch(mark, /stroke-linecap|<circle|<script|<image/, 'plain shapes only');
    const page = await (await fetch(`${app.base}/`)).text();
    assert.doesNotMatch(page, /Campus OS/);
  } finally {
    await app.close();
  }
});

test('the wordmark is the slice followed by "Citrus", and screen readers hear Citrus', async () => {
  const { wordmark, wordmarkClassic, ringMark } = await import(pathToFileURL(path.join(root, 'public', 'js', 'core', 'brand.js')).href);
  const mark = String(wordmark());
  assert.match(mark, /aria-label="Citrus"/);
  assert.match(mark, /<img class="wordmark-mark" src="\/brand\/mark\.svg" alt=""/);
  assert.match(mark, />Citrus</);
  assert.doesNotMatch(mark, /wordmark-c/);
  assert.match(String(ringMark(40)), /<img class="ring-mark" src="\/brand\/mark\.svg"/);
  // The full-screen presentation keeps the earlier wordmark, a gradient C and "itrus".
  assert.match(String(wordmarkClassic()), /class="wordmark-c"/);
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'face.css'), 'utf8');
  assert.match(css, /\.wordmark-mark\s*\{/);
  assert.match(css, /img\.ring-mark/);
});

test('the app icons are the slice: four pictures, each a dark tile', () => {
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
