'use strict';
/**
 * What the lecturer says is stored sealed, with a key for each lecture, and opened only for the lecturer who teaches
 * it (or as input to a model request). A student's pages never read it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createVault, PREFIX } = require('../src/modules/live/vault');
const { startApp } = require('./helpers');

const master = crypto.randomBytes(32);
const teaching = { 7: { id: 7 } };
const access = { teachingCourse: (user, courseId) => (user.role !== 'student' && user.id === teaching[courseId]?.id ? teaching[courseId] : null) };
const lecturer = { id: 7, role: 'lecturer' };
const session = (id, courseId = 7) => ({ id, course_id: courseId });

test('a line is sealed per lecture and opens only for that lecture', () => {
  const vault = createVault(master, { access });
  const sealed = vault.seal(1, 'The gradient points uphill.');
  assert.ok(sealed.startsWith(PREFIX) && !sealed.includes('gradient'));
  assert.notEqual(vault.seal(1, 'The gradient points uphill.'), sealed, 'a fresh nonce every time');
  assert.equal(vault.forAi(session(1), sealed), 'The gradient points uphill.');
  assert.equal(vault.forAi(session(2), sealed), '', 'another lecture’s key does not open it');
  assert.equal(vault.forAi(session(1), `${sealed.slice(0, -2)}AA`), '', 'a tampered line is left out, never shown garbled');
  assert.equal(createVault(crypto.randomBytes(32), { access }).forAi(session(1), sealed), '', 'another server key does not open it');
});

test('older plain text still reads, and empty stays empty', () => {
  const vault = createVault(master, { access });
  assert.equal(vault.forAi(session(1), 'written before the vault'), 'written before the vault');
  assert.equal(vault.seal(1, ''), '');
  assert.equal(vault.forAi(session(1), ''), '');
});

test('only the lecturer who teaches the lecture gets an opener', () => {
  const vault = createVault(master, { access });
  const sealed = vault.seal(1, 'secret words');
  assert.equal(vault.lecturer(session(1), lecturer)(sealed), 'secret words');
  assert.throws(() => vault.lecturer(session(1), { id: 8, role: 'student' }), /Only the lecturer/, 'a student');
  assert.throws(() => vault.lecturer(session(1), { id: 7, role: 'student' }), /Only the lecturer/, 'a student even with the lecturer’s id');
  assert.throws(() => vault.lecturer(session(1), { id: 9, role: 'lecturer' }), /Only the lecturer/, 'another lecturer');
  assert.throws(() => vault.lecturer(session(1), null), /Only the lecturer/);
});

test('rows written before the vault are sealed by the maintenance job, a few hundred at a time', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const lecturerId = await app.lecturer('prof');
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' });
    await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
    const sid = (await app.call('prof', 'POST', '/api/live/sessions', { course_id: course.body.id, title: 'Week 1', keep_transcript: true })).body.session.id;
    const now = new Date().toISOString();
    app.db.run("INSERT INTO live_transcript(session_id, minute, text, created) VALUES(?, 1, 'plain old line', ?)", sid, now);
    app.db.run("INSERT INTO live_moments(session_id, kind, minute, excerpt, created) VALUES(?, 'struggle', 1, 'plain excerpt', ?)", sid, now);
    // The app's own vault is the one that matters: run the job through it.
    const vault = app.app.deps.vault;
    const sealed = vault.sealLegacy(app.db);
    assert.equal(sealed, 2);
    assert.ok(app.db.get("SELECT text FROM live_transcript WHERE session_id = ?", sid).text.startsWith(PREFIX));
    assert.ok(app.db.get("SELECT excerpt FROM live_moments WHERE session_id = ?", sid).excerpt.startsWith(PREFIX));
    assert.equal(vault.sealLegacy(app.db), 0, 'nothing is sealed twice');
    // And the lecturer still reads them.
    const said = await (await app.call('prof', 'GET', `/api/live/sessions/${sid}/transcript.txt`, undefined, { raw: true })).text();
    assert.match(said, /plain old line/);
  } finally {
    await app.close();
  }
});

test('the vault is reached from the live module only, and never by a page a student sees', () => {
  const root = path.join(__dirname, '..', 'src');
  const users = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js') && /require\(['"][./]*(?:modules\/live\/)?vault['"]\)/.test(fs.readFileSync(file, 'utf8'))) users.push(path.relative(root, file).split(path.sep).join('/'));
    }
  };
  walk(root);
  assert.deepEqual(users.sort(), ['app.js'], 'only the composition root builds it; modules receive it as a dependency');

  // The routes a student calls never open a lecturer's words for the lecturer, and the recap never reads sealed columns.
  const routes = fs.readFileSync(path.join(root, 'modules/live/routes.js'), 'utf8');
  const recap = routes.slice(routes.indexOf("router.get('/api/live/sessions/:id/recap'"), routes.indexOf("router.get('/api/lectures/feed'"));
  assert.ok(recap.length > 500);
  assert.doesNotMatch(recap, /vault\.|heardText|heardInTargets|live_transcript|excerpt\b/, 'the recap reads nothing sealed');
  const ask = routes.slice(routes.indexOf("router.post('/api/live/sessions/:id/student-ask'"), routes.indexOf("router.post('/api/live/sessions/:id/transcript'"));
  assert.ok(ask.length > 500);
  assert.doesNotMatch(ask, /vault\.lecturer|forLecturer/, 'a student’s question is answered with the model-input door only');
});
