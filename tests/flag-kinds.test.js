'use strict';
/**
 * Two flags about how a lecture feels rather than what it says: "explanation too long" and "boring". Students send
 * them like any other flag; the lecturer sees them counted and in the review and the downloads; they are feedback on
 * the teaching, so they never count as something the class (or a student) has to go back and learn.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApp } = require('./helpers');
const { openDatabase } = require('../src/db/database');
const migrations = require('../src/db/migrations');

const MIN = 60_000;
const at = (base, minutes) => new Date(base + minutes * MIN).toISOString();

test('students flag a lecture as too long or boring; the lecturer sees counts, never names', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const lecturerId = await app.lecturer('prof');
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' });
    await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
    const ids = {};
    for (const who of ['ann', 'ben']) {
      ids[who] = (await app.register(who)).body.user.id;
      await app.call(who, 'POST', `/api/courses/${course.body.id}/enroll`);
    }
    const sid = (await app.call('prof', 'POST', '/api/live/sessions', { course_id: course.body.id, title: 'Week 5' })).body.session.id;

    const long = await app.call('ann', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'long', note: 'the same point three times' });
    assert.equal(long.status, 201);
    assert.equal((await app.call('ben', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'boring' })).status, 201);
    assert.equal((await app.call('ben', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'dull' })).status, 400, 'other kinds are still refused');

    const view = await app.call('prof', 'GET', `/api/live/sessions/${sid}`);
    assert.deepEqual(view.body.flagCounts, { confused: 0, fast: 0, example: 0, question: 0, long: 1, boring: 1 });
    assert.equal(view.body.flags.find((f) => f.kind === 'long').note, 'the same point three times');
    assert.ok(!JSON.stringify(view.body.flags).match(/ann|ben|user/i), 'no names or ids');
    assert.deepEqual((await app.call('ben', 'GET', `/api/live/sessions/${sid}`)).body.flags.map((f) => f.kind), ['boring'], 'a student only sees their own');

    // In the record: tagged for the lecturer, but not a follow-up, and not a study target for the student.
    const lecturerRecord = (await app.call('prof', 'GET', `/api/live/sessions/${sid}/record.txt`)).body;
    assert.match(lecturerRecord, /\[FLAG t=\S+ P\d+\] kind=too-long note="the same point three times"\n/, 'too-long is shown and carries no #follow-up');
    assert.match(lecturerRecord, /\[FLAG t=\S+ P\d+\] kind=boring\n/);
    assert.doesNotMatch(lecturerRecord, /kind=(too-long|boring)[^\n]*#follow-up/);
    assert.match(lecturerRecord, /too-long \(the explanation went on much too long\) or boring/, 'the instructions explain them');
    const anns = (await app.call('ann', 'GET', `/api/live/sessions/${sid}/record.txt`)).body;
    assert.match(anns, /kind=too-long/);
    // (The instructions at the top explain the #target tag, so only the data below them is checked.)
    assert.doesNotMatch(anns.slice(anns.lastIndexOf('\n=== DATA ===')), /#target/, 'feedback on the teaching is not something to study');
    assert.match(anns, /\[AVERAGE scope=P1\][^\n]*flags=1/, 'but it is still counted');

    const report = await app.call('prof', 'GET', `/api/live/sessions/${sid}/report`);
    assert.deepEqual(report.body.record.sections[0].followUp, false, 'a class that only called it long is not marked for follow-up');
    assert.equal(report.body.record.sections[0].flags, 2);
  } finally {
    await app.close();
  }
});

test('the database upgrade keeps every flag already stored and accepts the new kinds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citrus-flags-'));
  const db = openDatabase(path.join(dir, 'old.db'));
  try {
    // A database from before this change: every migration up to 27.
    for (const m of migrations.filter((x) => x.version <= 27).sort((a, b) => a.version - b.version)) m.up(db);
    db.exec('PRAGMA foreign_keys = OFF');
    db.run("INSERT INTO live_flags(id, session_id, user_id, kind, minute, note, explanation, created) VALUES(7, 1, 2, 'confused', 12, 'what is lambda?', 'It scales the vector.', ?)", at(0, 0));
    assert.throws(() => db.run("INSERT INTO live_flags(session_id, user_id, kind, minute, created) VALUES(1, 2, 'boring', 3, ?)", at(0, 0)), /CHECK|constraint/i, 'the old table refuses the new kind');

    migrations.find((m) => m.version === 28).up(db);
    const kept = db.get('SELECT * FROM live_flags WHERE id = 7');
    assert.deepEqual([kept.kind, kept.minute, kept.note, kept.explanation], ['confused', 12, 'what is lambda?', 'It scales the vector.'], 'nothing was lost');
    db.run("INSERT INTO live_flags(session_id, user_id, kind, minute, created) VALUES(1, 2, 'boring', 3, ?)", at(0, 1));
    db.run("INSERT INTO live_flags(session_id, user_id, kind, minute, created) VALUES(1, 2, 'long', 4, ?)", at(0, 2));
    assert.throws(() => db.run("INSERT INTO live_flags(session_id, user_id, kind, minute, created) VALUES(1, 2, 'dull', 4, ?)", at(0, 3)), /CHECK|constraint/i, 'still only the known kinds');
    assert.ok(db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_live_flags'").length, 'the index came back');

    migrations.find((m) => m.version === 28).up(db); // running it again changes nothing
    assert.equal(db.all('SELECT * FROM live_flags').length, 3);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
