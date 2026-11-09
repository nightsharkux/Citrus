'use strict';
/** Students see lectures with their times: live now, coming up, recent; and can join the course from the list. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { classify, order } = require('../src/modules/live/lectures');

const HOUR = 3_600_000;
const iso = (offset) => new Date(Date.now() + offset).toISOString();

test('a lecture is live, upcoming, past or open, and the list puts live first then soonest', () => {
  const now = Date.now();
  assert.equal(classify({ status: 'active', starts: iso(-HOUR / 2), ends: iso(HOUR / 2) }, { live: true, now }), 'live');
  assert.equal(classify({ status: 'active', starts: iso(2 * HOUR), ends: iso(3 * HOUR) }, { now }), 'upcoming');
  assert.equal(classify({ status: 'active', starts: iso(-3 * HOUR), ends: iso(-2 * HOUR) }, { now }), 'past');
  assert.equal(classify({ status: 'ended', starts: iso(HOUR) }, { now }), 'past');
  assert.equal(classify({ status: 'active', starts: null }, { now }), 'open');
  const items = [
    { state: 'past', created: iso(-5 * HOUR), starts: iso(-5 * HOUR) },
    { state: 'upcoming', starts: iso(5 * HOUR) },
    { state: 'live', starts: iso(-HOUR) },
    { state: 'upcoming', starts: iso(HOUR) },
  ].sort(order);
  assert.deepEqual(items.map((i) => i.state), ['live', 'upcoming', 'upcoming', 'past']);
  assert.ok(Date.parse(items[1].starts) < Date.parse(items[2].starts));
});

test('a student sees scheduled and live lectures with times, finds other courses’ lectures, and joins in one step', async () => {
  const app = await startApp();
  try {
    await app.register('prof', { role: 'lecturer' });
    await app.register('prof2', { role: 'lecturer' });
    const mine = (await app.call('prof', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' })).body.id;
    const other = (await app.call('prof2', 'POST', '/api/courses', { title: 'Databases', code: 'DB200' })).body.id;
    await app.register('stu');
    await app.call('stu', 'POST', `/api/courses/${mine}/enroll`);

    // The lecturer schedules a lecture with a time and a room; validation is strict.
    const bad = await app.call('prof', 'POST', `/api/courses/${mine}/lectures`, { topic: 'Week 1', starts: 'tomorrow-ish' });
    assert.equal(bad.status, 400);
    assert.equal((await app.call('prof', 'POST', `/api/courses/${mine}/lectures`, { topic: 'Week 1', starts: iso(HOUR), duration_minutes: 5 })).status, 400);
    const planned = await app.call('prof', 'POST', `/api/courses/${mine}/lectures`, { topic: 'Week 6: Trees', starts: iso(3 * HOUR), duration_minutes: 90, room: 'HSG 001' });
    assert.equal(planned.status, 201);
    await app.call('prof2', 'POST', `/api/courses/${other}/lectures`, { topic: 'Joins explained', starts: iso(26 * HOUR), room: 'WTC 2' });
    assert.equal((await app.call('stu', 'POST', `/api/courses/${mine}/lectures`, { topic: 'Sneaky' })).status, 403);

    // The student was told about the new lecture, and sees it with date, time and room.
    const inbox = JSON.stringify((await app.call('stu', 'GET', '/api/notifications')).body);
    assert.match(inbox, /Lecture scheduled: Week 6: Trees/);
    let feed = (await app.call('stu', 'GET', '/api/lectures/feed')).body.lectures;
    const week6 = feed.find((l) => l.topic === 'Week 6: Trees');
    assert.deepEqual({ state: week6.state, room: week6.room, enrolled: week6.enrolled, code: week6.course.code }, { state: 'upcoming', room: 'HSG 001', enrolled: true, code: 'ML101' });
    assert.equal(Date.parse(week6.ends) - Date.parse(week6.starts), 90 * 60_000);
    const joins = feed.find((l) => l.topic === 'Joins explained');
    assert.equal(joins.enrolled, false, 'other courses’ lectures are visible and joinable');
    assert.equal((await app.call('stu', 'GET', '/api/lectures/feed?scope=mine')).body.lectures.some((l) => l.topic === 'Joins explained'), false);

    // A lecturer only sees their own teaching.
    assert.deepEqual((await app.call('prof', 'GET', '/api/lectures/feed')).body.lectures.map((l) => l.topic), ['Week 6: Trees']);
    assert.equal((await app.call('anon', 'GET', '/api/lectures/feed')).status, 401);

    // Starting the scheduled lecture live makes it "live" for the student, who is told.
    const live = await app.call('prof', 'POST', '/api/live/sessions', { course_id: mine, lecture_id: planned.body.id });
    assert.equal(live.status, 201);
    assert.equal(live.body.session.title, 'Week 6: Trees');
    feed = (await app.call('stu', 'GET', '/api/lectures/feed')).body.lectures;
    assert.equal(feed[0].topic, 'Week 6: Trees');
    assert.equal(feed[0].state, 'live');
    assert.equal(feed[0].liveSession, live.body.session.id);
    assert.match(JSON.stringify((await app.call('stu', 'GET', '/api/notifications')).body), /Week 6: Trees is live/);
    assert.equal((await app.call('prof', 'POST', '/api/live/sessions', { course_id: mine, lecture_id: planned.body.id })).body.resumed, true, 'starting again resumes the running lecture');

    // The student joins the other course straight from the list, then sees it as theirs.
    assert.equal((await app.call('stu', 'POST', `/api/courses/${other}/enroll`)).status, 200);
    assert.equal((await app.call('stu', 'GET', '/api/lectures/feed?scope=mine')).body.lectures.some((l) => l.topic === 'Joins explained'), true);

    // Ending it moves it to the past; an ad-hoc live lecture creates its own lecture.
    await app.call('prof', 'POST', `/api/live/sessions/${live.body.session.id}/end`);
    feed = (await app.call('stu', 'GET', '/api/lectures/feed?scope=mine')).body.lectures;
    assert.equal(feed.find((l) => l.topic === 'Week 6: Trees').state, 'past');
    const adhoc = await app.call('prof', 'POST', '/api/live/sessions', { course_id: mine, title: 'Extra session' });
    assert.equal((await app.call('stu', 'GET', '/api/lectures/feed')).body.lectures[0].topic, 'Extra session');
    assert.equal(adhoc.status, 201);
  } finally {
    await app.close();
  }
});
