'use strict';
/**
 * Breaks and chapters of a live lecture, and tidying its recording: a lecturer pauses for a break (students cannot
 * answer, nothing is kept, the break is not counted in the lecture's minutes), marks chapters like laps on a
 * stopwatch and names them later, and deletes what was recorded in one chapter or all of it. Only the lecturer of
 * the course can do any of it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { breakMsBefore, activeMs, shiftIso, totalBreakMs } = require('../src/modules/live/breaks');

const MIN = 60_000;
const at = (base, minutes) => new Date(base + minutes * MIN).toISOString();

async function setup() {
  const app = await startApp();
  await app.login('admin');
  const lecturerId = await app.lecturer('prof');
  await app.lecturer('other');
  const course = await app.call('admin', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' });
  await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
  const ann = await app.register('ann');
  await app.call('ann', 'POST', `/api/courses/${course.body.id}/enroll`);
  const started = await app.call('prof', 'POST', '/api/live/sessions', { course_id: course.body.id, title: 'Week 5' });
  return { app, courseId: course.body.id, sid: started.body.session.id, annId: ann.body.user.id };
}

test('teaching time leaves breaks out', () => {
  const t0 = Date.parse('2026-11-19T08:15:00Z');
  const breaks = [{ started: at(t0, 20), ended: at(t0, 30) }, { started: at(t0, 50), ended: null }];
  assert.equal(breakMsBefore(breaks, t0 + 10 * MIN, t0 + 90 * MIN), 0, 'before the first break');
  assert.equal(breakMsBefore(breaks, t0 + 25 * MIN, t0 + 90 * MIN), 5 * MIN, 'in the middle of a break');
  assert.equal(breakMsBefore(breaks, t0 + 40 * MIN, t0 + 90 * MIN), 10 * MIN, 'after it');
  assert.equal(activeMs(at(t0, 0), breaks, t0 + 40 * MIN, t0 + 90 * MIN), 30 * MIN);
  assert.equal(shiftIso(breaks, at(t0, 40), t0 + 90 * MIN), at(t0, 30), 'a time after the break moves back by its length');
  assert.equal(totalBreakMs(breaks, t0 + 90 * MIN), 50 * MIN, 'an open break counts up to now');
  // 80 minutes on the clock, 10 + 30 of them break (the open one since minute 50): 40 minutes of teaching.
  assert.equal(activeMs(at(t0, 0), breaks, t0 + 80 * MIN, t0 + 90 * MIN), 40 * MIN, 'the open break stops the clock');
});

test('a break stops the lecture: no answers, no flags, nothing heard; resuming brings it back', async () => {
  const { app, sid } = await setup();
  try {
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/signal`, { level: 1 })).status, 200);
    const paused = await app.call('prof', 'POST', `/api/live/sessions/${sid}/pause`);
    assert.equal(paused.status, 200);
    assert.equal(paused.body.session.paused, true);
    assert.ok(paused.body.session.pausedAt);

    // Pausing again changes nothing.
    assert.equal((await app.call('prof', 'POST', `/api/live/sessions/${sid}/pause`)).body.session.pausedAt, paused.body.session.pausedAt);
    assert.equal(app.db.all('SELECT * FROM live_breaks WHERE session_id = ?', sid).length, 1);

    const answer = await app.call('ann', 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 });
    assert.equal(answer.status, 409);
    assert.match(answer.body.error, /break/i);
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'confused' })).status, 409);
    const heard = await app.call('prof', 'POST', `/api/live/sessions/${sid}/transcript`, { text: 'Coffee is ready' });
    assert.equal(heard.body.paused, true);
    assert.equal(app.db.all('SELECT * FROM live_transcript WHERE session_id = ?', sid).length, 0, 'nothing is kept during a break');
    assert.equal((await app.call('ann', 'GET', `/api/live/sessions/${sid}`)).body.session.paused, true, 'students see the break');

    const resumed = await app.call('prof', 'POST', `/api/live/sessions/${sid}/resume`);
    assert.equal(resumed.body.session.paused, false);
    assert.ok(app.db.get('SELECT ended FROM live_breaks WHERE session_id = ?', sid).ended, 'the break is closed');
    assert.equal((await app.call('prof', 'POST', `/api/live/sessions/${sid}/transcript`, { text: 'Welcome back' })).body.lines, 1);
  } finally {
    await app.close();
  }
});

test('the minutes of a lecture do not count its break', async () => {
  const { app, sid } = await setup();
  try {
    const t0 = Date.now() - 60 * MIN;
    app.db.run('UPDATE live_sessions SET started = ? WHERE id = ?', at(t0, 0), sid);
    app.db.run('INSERT INTO live_breaks(session_id, started, ended) VALUES(?, ?, ?)', sid, at(t0, 20), at(t0, 50));
    // An hour on the clock, thirty minutes of it a break: this is minute 30 of the lecture, not 60.
    const flag = await app.call('ann', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'confused' });
    assert.equal(flag.status, 201);
    assert.ok(flag.body.minute >= 30 && flag.body.minute <= 31, `minute ${flag.body.minute}`);
    const view = await app.call('prof', 'GET', `/api/live/sessions/${sid}`);
    assert.ok(view.body.timeline.length >= 30 && view.body.timeline.length <= 31, `${view.body.timeline.length} timeline minutes`);
    assert.equal(view.body.session.breakMs, 30 * MIN, 'the clients get the closed break time to subtract');
  } finally {
    await app.close();
  }
});

test('ending the lecture during a break ends the break too', async () => {
  const { app, sid } = await setup();
  try {
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/pause`);
    assert.equal((await app.call('prof', 'POST', `/api/live/sessions/${sid}/end`)).status, 200);
    const row = app.db.get('SELECT ended, paused_at FROM live_sessions WHERE id = ?', sid);
    assert.ok(row.ended);
    assert.equal(row.paused_at, null);
    assert.ok(app.db.get('SELECT ended FROM live_breaks WHERE session_id = ?', sid).ended);
    assert.equal((await app.call('prof', 'POST', `/api/live/sessions/${sid}/pause`)).status, 409, 'an ended lecture cannot be paused');
  } finally {
    await app.close();
  }
});

test('chapters: a lap button, names added afterwards, merging', async () => {
  const { app, sid } = await setup();
  try {
    const first = await app.call('prof', 'GET', `/api/live/sessions/${sid}/chapters`);
    assert.equal(first.body.chapters.length, 1, 'every lecture starts with a chapter');
    assert.equal(first.body.chapters[0].name, 'Chapter 1');

    // Pretend the lecture has been running a while, so the marks fall apart from each other.
    const t0 = Date.now() - 40 * MIN;
    app.db.run('UPDATE live_sessions SET started = ? WHERE id = ?', at(t0, 0), sid);
    app.db.run('UPDATE live_chapters SET started = ? WHERE session_id = ?', at(t0, 0), sid);
    app.db.run('INSERT INTO live_chapters(session_id, started, title, created) VALUES(?, ?, ?, ?)', sid, at(t0, 15), '', at(t0, 15));

    const tapped = await app.call('prof', 'POST', `/api/live/sessions/${sid}/chapters`, {});
    assert.equal(tapped.status, 201);
    assert.equal(tapped.body.chapters.length, 3);
    const [one, two, three] = tapped.body.chapters;
    assert.equal(one.from, 0);
    assert.equal(two.from, 15 * 60);
    assert.equal(one.to, two.from, 'a chapter runs to the next mark');
    assert.equal(three.running, true);

    // An accidental second tap is the same mark.
    const again = await app.call('prof', 'POST', `/api/live/sessions/${sid}/chapters`, {});
    assert.equal(again.body.added, false);
    assert.equal(again.body.chapters.length, 3);

    const named = await app.call('prof', 'PATCH', `/api/live/sessions/${sid}/chapters/${two.id}`, { title: '  Gradient descent  ' });
    assert.equal(named.body.chapters[1].name, 'Gradient descent');
    assert.equal((await app.call('prof', 'PATCH', `/api/live/sessions/${sid}/chapters/${two.id}`, { title: '' })).body.chapters[1].name, 'Chapter 2', 'a cleared name goes back to the number');
    assert.equal((await app.call('prof', 'PATCH', `/api/live/sessions/${sid}/chapters/${two.id}`, {})).status, 400);

    // Deleting a mark merges the chapter into the one before.
    const merged = await app.call('prof', 'DELETE', `/api/live/sessions/${sid}/chapters/${two.id}`);
    assert.deepEqual(merged.body.chapters.map((c) => c.n), [1, 2]);
    assert.equal(merged.body.chapters[0].to, merged.body.chapters[1].from);
    // The first chapter starts with the lecture: deleting it hands that start to the next one.
    const withoutFirst = await app.call('prof', 'DELETE', `/api/live/sessions/${sid}/chapters/${one.id}`);
    assert.equal(withoutFirst.body.chapters.length, 1);
    assert.equal(withoutFirst.body.chapters[0].from, 0);
    assert.equal((await app.call('prof', 'DELETE', `/api/live/sessions/${sid}/chapters/${withoutFirst.body.chapters[0].id}`)).status, 409, 'the last chapter stays');
    assert.equal((await app.call('prof', 'DELETE', `/api/live/sessions/${sid}/chapters/99999`)).status, 404);
  } finally {
    await app.close();
  }
});

test('the lecture record follows the chapters and counts teaching time', async () => {
  const { app, sid } = await setup();
  try {
    const t0 = Date.now() - 70 * MIN;
    app.db.run('UPDATE live_sessions SET started = ?, ended = ? WHERE id = ?', at(t0, 0), at(t0, 60), sid);
    app.db.run('DELETE FROM live_chapters WHERE session_id = ?', sid);
    for (const [minutes, title] of [[0, 'Intro'], [15, ''], [45, 'Summary']]) app.db.run('INSERT INTO live_chapters(session_id, started, title, created) VALUES(?, ?, ?, ?)', sid, at(t0, minutes), title, at(t0, minutes));
    app.db.run('INSERT INTO live_breaks(session_id, started, ended) VALUES(?, ?, ?)', sid, at(t0, 20), at(t0, 30)); // ten minutes off

    const record = (await app.call('prof', 'GET', `/api/live/sessions/${sid}/record.txt`)).body;
    assert.match(record, /duration: 00:50:00 \(teaching time; one break of 10 min left out\)/);
    assert.match(record, /\[SECTION P1 t=00:00:00-00:15:00\] "Intro"/);
    assert.match(record, /\[SECTION P2 t=00:15:00-00:35:00\] "Chapter 2"/, 'the break is inside chapter 2 and not counted in it');
    assert.match(record, /\[SECTION P3 t=00:35:00-00:50:00\] "Summary"/);
    assert.match(record, /\[BREAK t=00:20:00 P2\] the lecture was paused for 10 min/);

    const report = await app.call('prof', 'GET', `/api/live/sessions/${sid}/report`);
    const sections = report.body.record.sections;
    assert.deepEqual(sections.map((s) => s.title), ['Intro', 'Chapter 2', 'Summary']);
    assert.deepEqual(sections.map((s) => s.custom), [true, false, true]);
    assert.ok(sections.every((s) => s.chapterId), 'the review can name them');
  } finally {
    await app.close();
  }
});

test('the lecturer deletes what was recorded in one chapter, or only the audio, or everything', async () => {
  const { app, sid } = await setup();
  try {
    const t0 = Date.now() - 60 * MIN;
    app.db.run('UPDATE live_sessions SET started = ?, ended = ? WHERE id = ?', at(t0, 0), at(t0, 50), sid);
    app.db.run('DELETE FROM live_chapters WHERE session_id = ?', sid);
    const ids = [0, 20, 40].map((m) => app.db.insert('INSERT INTO live_chapters(session_id, started, title, created) VALUES(?, ?, ?, ?)', sid, at(t0, m), `Part ${m}`, at(t0, m)));
    for (const m of [5, 10, 25, 30, 45]) app.db.run('INSERT INTO live_transcript(session_id, minute, text, created) VALUES(?, ?, ?, ?)', sid, m, `said at ${m}`, at(t0, m));
    for (const m of [5, 25, 45]) app.db.run('INSERT INTO live_recordings(session_id, user_id, blob_url, mime, bytes, recorded_at, duration_ms, created) VALUES(?, NULL, ?, ?, ?, ?, ?, ?)', sid, `https://blob.test/${m}`, 'audio/aac', 100, t0 + m * MIN, 60_000, at(t0, m));
    app.db.run("INSERT INTO live_moments(session_id, kind, minute, answered, lost, unsure, excerpt, note, created) VALUES(?, 'struggle', 25, 5, 3, 1, 'the sign of the gradient', 'sign', ?)", sid, at(t0, 25));
    app.db.run("INSERT INTO live_moments(session_id, kind, minute, note, created) VALUES(?, 'point', 26, 'The update subtracts the gradient', ?)", sid, at(t0, 26));

    assert.equal((await app.call('ann', 'DELETE', `/api/live/sessions/${sid}/chapters/${ids[1]}/content`)).status, 403, 'students cannot');
    assert.equal((await app.call('other', 'DELETE', `/api/live/sessions/${sid}/chapters/${ids[1]}/content`)).status, 403, 'another lecturer cannot');

    const middle = await app.call('prof', 'DELETE', `/api/live/sessions/${sid}/chapters/${ids[1]}/content`);
    assert.equal(middle.status, 200);
    assert.deepEqual(middle.body.deleted, { lines: 2, audio: 1 });
    const left = app.db.all('SELECT text FROM live_transcript WHERE session_id = ? ORDER BY id', sid).map((r) => r.text);
    assert.deepEqual(left, ['said at 5', 'said at 10', 'said at 45'], 'only that chapter went');
    assert.equal(app.db.all('SELECT * FROM live_recordings WHERE session_id = ?', sid).length, 2);
    assert.equal(app.db.get("SELECT excerpt FROM live_moments WHERE session_id = ? AND kind = 'struggle'", sid).excerpt, '', 'a kept excerpt of that stretch goes');
    assert.equal(app.db.all("SELECT * FROM live_moments WHERE session_id = ? AND kind = 'point'", sid).length, 0, 'and so does its key point');
    assert.equal(middle.body.chapters.length, 3, 'the chapters themselves stay');

    // Only the audio: the transcript stays.
    assert.equal((await app.call('ann', 'DELETE', `/api/live/sessions/${sid}/audio`)).status, 403);
    assert.deepEqual((await app.call('prof', 'DELETE', `/api/live/sessions/${sid}/audio`)).body.deleted, { audio: 2 });
    assert.equal(app.db.all('SELECT * FROM live_recordings WHERE session_id = ?', sid).length, 0);
    assert.equal(app.db.all('SELECT * FROM live_transcript WHERE session_id = ?', sid).length, 3);

    // Everything: the existing route.
    assert.equal((await app.call('prof', 'DELETE', `/api/live/sessions/${sid}/transcript`)).status, 200);
    assert.equal(app.db.all('SELECT * FROM live_transcript WHERE session_id = ?', sid).length, 0);
  } finally {
    await app.close();
  }
});

test('only the lecturer of the course runs breaks and chapters', async () => {
  const { app, sid } = await setup();
  try {
    for (const who of ['ann', 'other']) {
      assert.equal((await app.call(who, 'POST', `/api/live/sessions/${sid}/pause`)).status, 403, `${who} cannot pause`);
      assert.equal((await app.call(who, 'POST', `/api/live/sessions/${sid}/resume`)).status, 403);
      assert.equal((await app.call(who, 'GET', `/api/live/sessions/${sid}/chapters`)).status, 403);
      assert.equal((await app.call(who, 'POST', `/api/live/sessions/${sid}/chapters`, {})).status, 403);
    }
    const chapter = (await app.call('prof', 'GET', `/api/live/sessions/${sid}/chapters`)).body.chapters[0];
    assert.equal((await app.call('ann', 'PATCH', `/api/live/sessions/${sid}/chapters/${chapter.id}`, { title: 'Mine' })).status, 403);
    assert.equal((await app.call('other', 'DELETE', `/api/live/sessions/${sid}/chapters/${chapter.id}`)).status, 403);
    assert.equal((await app.call('prof', 'GET', `/api/live/sessions/${sid}/chapters`)).body.chapters[0].title, '', 'nothing changed');
    assert.equal((await app.call(null, 'POST', `/api/live/sessions/${sid}/pause`)).status, 401, 'signed out');
  } finally {
    await app.close();
  }
});
