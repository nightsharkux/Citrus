'use strict';
/** Account self-service (password, sessions, export, deletion), Moodle connector, and upgrading a 0.6 database. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { startApp, PASSWORD } = require('./helpers');
const { openDatabase } = require('../src/db/database');
const { runMigrations } = require('../src/db/migrate');

test('password change, session management, data export and account deletion', async () => {
  const app = await startApp();
  try {
    const reg = await app.register('stu');
    await app.login('laptop', 'stu@test.invalid', PASSWORD);
    const sessions = (await app.call('stu', 'GET', '/api/me/sessions')).body.sessions;
    assert.equal(sessions.length, 2);
    assert.ok(sessions.some((s) => s.current));
    assert.ok(sessions.every((s) => s.id.length === 12), 'session ids never expose tokens');

    assert.equal((await app.call('stu', 'POST', '/api/me/password', { current: 'wrong', next: 'Another-password-123' })).status, 403);
    assert.equal((await app.call('stu', 'POST', '/api/me/password', { current: PASSWORD, next: 'Another-password-123' })).status, 200);
    assert.equal((await app.call('laptop', 'GET', '/api/me')).status, 401, 'other sessions are signed out');

    await app.call('stu', 'PUT', '/api/me/profile', { programme: 'DTM', semester: 3, interests: ['data', 'ai', 'not-a-tag'] });
    const me = (await app.call('stu', 'GET', '/api/me')).body;
    assert.deepEqual(me.profile.interests, ['data', 'ai']);

    await app.call('stu', 'POST', '/api/workspaces', { title: 'My group', kind: 'study' });
    const exported = await app.call('stu', 'GET', '/api/me/export');
    assert.equal(exported.body.account.email, 'stu@test.invalid');
    assert.equal(exported.body.profile.programme, 'DTM');

    assert.equal((await app.call('stu', 'POST', '/api/me/delete', { password: 'Another-password-123', confirm: 'nope' })).status, 400);
    assert.equal((await app.call('stu', 'POST', '/api/me/delete', { password: 'Another-password-123', confirm: 'DELETE' })).status, 200);
    const row = app.db.prepare('SELECT name, email, deleted FROM users WHERE id = ?').get(reg.body.user.id);
    assert.deepEqual([row.name, row.deleted], ['Deleted user', 1]);
    assert.equal((await app.call('stu2', 'POST', '/api/login', { email: 'stu@test.invalid', password: 'Another-password-123' })).status, 401);

    await app.login('admin');
    assert.equal((await app.call('admin', 'POST', '/api/me/delete', { password: 'Admin-password-for-tests-1', confirm: 'DELETE' })).status, 403, 'last admin cannot delete themselves');
  } finally {
    await app.close();
  }
});

test('Moodle connector verifies personal tokens and lists courses', async () => {
  const moodle = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const form = new URLSearchParams(raw);
    res.setHeader('content-type', 'application/json');
    if (form.get('wstoken') !== 'valid-token-0123456789') return res.end(JSON.stringify({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token' }));
    if (form.get('wsfunction') === 'core_webservice_get_site_info') return res.end(JSON.stringify({ userid: 7, fullname: 'Sam Student', sitename: 'Test Moodle' }));
    if (form.get('wsfunction') === 'core_enrol_get_users_courses') return res.end(JSON.stringify([{ id: 42, fullname: 'Statistics', shortname: 'STAT', progress: 40 }]));
    return res.end('{}');
  });
  await new Promise((r) => moodle.listen(0, '127.0.0.1', r));
  const app = await startApp({ env: { MOODLE_URL: `http://127.0.0.1:${moodle.address().port}` } });
  try {
    await app.register('stu');
    assert.equal((await app.call('stu', 'POST', '/api/integrations/moodle', { token: 'wrong-token-0123456789' })).status, 400);
    const ok = await app.call('stu', 'POST', '/api/integrations/moodle', { token: 'valid-token-0123456789' });
    assert.equal(ok.body.account.fullName, 'Sam Student');
    assert.ok(!JSON.stringify(app.db.prepare('SELECT secret FROM connector_tokens').get()).includes('valid-token'), 'token encrypted at rest');
    const courses = await app.call('stu', 'GET', '/api/integrations/moodle/courses');
    assert.equal(courses.body.courses[0].url.endsWith('/course/view.php?id=42'), true);
  } finally {
    await app.close();
    await new Promise((r) => moodle.close(r));
  }
});

test('a CampusOS 0.6 database upgrades in place without losing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campusos-upgrade-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE institutions(id INTEGER PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,created TEXT NOT NULL);
    CREATE TABLE users(id INTEGER PRIMARY KEY, institution_id INTEGER NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL,pass TEXT NOT NULL,role TEXT NOT NULL,created TEXT NOT NULL,UNIQUE(institution_id,email));
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,institution_id INTEGER NOT NULL,creator_id INTEGER NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,course_id INTEGER,join_code TEXT NOT NULL UNIQUE,guidance TEXT NOT NULL DEFAULT 'coach',instructions TEXT NOT NULL DEFAULT '',created TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ai_chats(id INTEGER PRIMARY KEY,workspace_id INTEGER NOT NULL,user_id INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE institution_ai_settings(institution_id INTEGER PRIMARY KEY,provider TEXT NOT NULL CHECK (provider IN ('off','openai','ollama')),updated TEXT NOT NULL);
    CREATE TABLE institution_knowledge(id INTEGER PRIMARY KEY,institution_id INTEGER NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE career_interests(user_id INTEGER PRIMARY KEY,institution_id INTEGER NOT NULL,answers TEXT NOT NULL,updated TEXT NOT NULL);
    INSERT INTO institutions VALUES(1,'Old Uni','demo-university','2026-01-01');
    INSERT INTO users VALUES(1,1,'Old Admin','old@uni.example','salt:hash','admin','2026-01-01');
    INSERT INTO workspaces VALUES(1,1,1,'My AI Desk','study',NULL,'ABC123','coach','','2026-01-01',0);
    INSERT INTO workspaces VALUES(2,1,1,'Project team','meeting',NULL,'DEF456','coach','','2026-01-01',0);
    INSERT INTO ai_chats VALUES(1,1,1,'user','What is a tensor?','2026-01-02'),(2,1,1,'assistant','A multi-dimensional array.','2026-01-02');
    INSERT INTO institution_ai_settings VALUES(1,'ollama','2026-01-01');
  `);
  old.close();

  const db = openDatabase(file);
  try {
    assert.equal(runMigrations(db), 10);
    assert.equal(runMigrations(db), 0, 'idempotent');
    const tools = db.get('SELECT web_search, speech FROM institution_ai_settings WHERE institution_id = 1');
    assert.deepEqual({ ...tools }, { web_search: 1, speech: 1 }, 'web search and natural voices default to on for existing institutions');
    assert.ok(db.columns('quizzes').includes('questions') && db.columns('quiz_answers').includes('feedback'));
    assert.equal(db.get('SELECT name FROM users WHERE id = 1').name, 'Old Admin');
    assert.ok(db.columns('users').includes('requested_role') && db.columns('users').includes('preferences'));
    assert.ok(db.columns('career_interests').includes('reflection'));
    assert.equal(db.get('SELECT archived FROM workspaces WHERE id = 1').archived, 1, 'old AI desk archived');
    assert.equal(db.get('SELECT archived FROM workspaces WHERE id = 2').archived, 0);
    const thread = db.get('SELECT * FROM assistant_threads WHERE user_id = 1');
    assert.equal(thread.title, 'What is a tensor?');
    assert.equal(db.get('SELECT COUNT(*) n FROM assistant_messages WHERE thread_id = ?', thread.id).n, 2);
    assert.equal(db.get('SELECT provider FROM institution_ai_settings').provider, 'ollama');
    db.run("UPDATE institution_ai_settings SET provider = 'anthropic'");
    assert.equal(db.get('SELECT provider FROM institution_ai_settings').provider, 'anthropic', 'old CHECK constraint removed');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
