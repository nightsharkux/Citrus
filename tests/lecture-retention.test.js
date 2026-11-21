'use strict';
/**
 * What a lecture holds in words (transcript, trouble excerpts, the notes on students' flags) is removed after the
 * institution's period, a year unless it chose otherwise. The results of the lecture stay.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

async function lecture(app) {
  await app.login('admin');
  const lecturerId = await app.lecturer('prof');
  const course = await app.call('admin', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' });
  await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
  const ann = await app.register('ann');
  await app.call('ann', 'POST', `/api/courses/${course.body.id}/enroll`);
  const sid = (await app.call('prof', 'POST', '/api/live/sessions', { course_id: course.body.id, title: 'Week 1' })).body.session.id;
  const vault = app.app.deps.vault;
  const old = daysAgo(400);
  const fresh = daysAgo(2);
  app.db.run('INSERT INTO live_transcript(session_id, minute, text, created) VALUES(?, 1, ?, ?)', sid, vault.seal(sid, 'an old line'), old);
  app.db.run('INSERT INTO live_transcript(session_id, minute, text, created) VALUES(?, 2, ?, ?)', sid, vault.seal(sid, 'a recent line'), fresh);
  app.db.run("INSERT INTO live_moments(session_id, kind, minute, excerpt, note, created) VALUES(?, 'struggle', 1, ?, 'sticking point', ?)", sid, vault.seal(sid, 'old words'), old);
  app.db.run("INSERT INTO live_flags(session_id, user_id, kind, minute, note, explanation, created) VALUES(?, ?, 'confused', 1, 'my old question', 'an old explanation', ?)", sid, ann.body.user.id, old);
  app.db.run("INSERT INTO live_flags(session_id, user_id, kind, minute, note, explanation, created) VALUES(?, ?, 'confused', 2, 'my new question', '', ?)", sid, ann.body.user.id, fresh);
  app.db.run('INSERT INTO live_signals(session_id, user_id, level, created) VALUES(?, ?, 3, ?)', sid, ann.body.user.id, old);
  return sid;
}

test('after a year, transcript lines, trouble excerpts and flag notes are removed; results and recent lines stay', async () => {
  const app = await startApp();
  try {
    const sid = await lecture(app);
    const result = app.app.maintenance.run();
    assert.ok(result.lectureTextRemoved >= 3);
    assert.deepEqual(app.db.all('SELECT minute FROM live_transcript WHERE session_id = ?', sid).map((r) => r.minute), [2], 'only the recent line is left');
    const moment = app.db.get('SELECT excerpt, note FROM live_moments WHERE session_id = ?', sid);
    assert.deepEqual([moment.excerpt, moment.note], ['', 'sticking point'], 'the words go, Citrus’s note stays');
    const flags = app.db.all('SELECT minute, note, explanation FROM live_flags WHERE session_id = ? ORDER BY minute', sid);
    assert.deepEqual(flags.map((f) => [f.minute, f.note, f.explanation]), [[1, '', ''], [2, 'my new question', '']], 'the old flag stays as a moment, without the words');
    assert.equal(app.db.get('SELECT COUNT(*) n FROM live_signals WHERE session_id = ?', sid).n, 1, 'how students followed is a result and stays');
  } finally {
    await app.close();
  }
});

test('the period is the institution’s to set, 0 keeps everything, and only an administrator sets it', async () => {
  const app = await startApp();
  try {
    const sid = await lecture(app);
    assert.equal((await app.call('prof', 'PATCH', '/api/admin/settings', { lectureTextRetentionDays: 30 })).status, 403);
    assert.equal((await app.call('admin', 'PATCH', '/api/admin/settings', { lectureTextRetentionDays: 0 })).status, 200);
    assert.equal(app.app.maintenance.run().lectureTextRemoved, 0, '0 = keep');
    assert.equal(app.db.get('SELECT COUNT(*) n FROM live_transcript WHERE session_id = ?', sid).n, 2);

    assert.equal((await app.call('admin', 'PATCH', '/api/admin/settings', { lectureTextRetentionDays: 1 })).status, 200);
    app.app.maintenance.run();
    assert.equal(app.db.get('SELECT COUNT(*) n FROM live_transcript WHERE session_id = ?', sid).n, 0, 'a day: even the recent line is past it');
    assert.equal((await app.call('admin', 'PATCH', '/api/admin/settings', { lectureTextRetentionDays: -5 })).status, 400);
  } finally {
    await app.close();
  }
});
