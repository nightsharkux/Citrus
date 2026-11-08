'use strict';
/** Schedule (DST-safe recurrence, ICS import/export, feed) and learning (spaced review, practice sets, check-in codes). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { parseIcs, toIcs } = require('../src/lib/ics');
const { schedule } = require('../src/modules/study/review');
const { createParticipation, codeFor } = require('../src/modules/participation/service');

const berlin = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

test('weekly lectures keep their local time across the daylight-saving change', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    await app.register('stu');
    await app.call('stu', 'POST', '/api/courses/1/enroll');
    // 10:00 Berlin summer time (UTC+2) on 13 Oct 2026; clocks go back on 25 Oct.
    const r = await app.call('admin', 'POST', '/api/timetable', { title: 'Algorithms', kind: 'lecture', scope: 'course', course_id: 1, starts: '2026-10-13T08:00:00.000Z', ends: '2026-10-13T09:30:00.000Z', repeat_weeks: 1, location: 'MF2' });
    assert.equal(r.status, 201);
    const events = (await app.call('stu', 'GET', '/api/timetable?from=2026-10-12T00:00:00Z&to=2026-11-10T00:00:00Z')).body.events;
    assert.equal(events.length, 4);
    for (const e of events) assert.equal(berlin(e.starts), '10:00');
    assert.equal(events[2].starts, '2026-10-27T09:00:00.000Z', 'UTC shifts by an hour after the change');
    assert.equal((await app.call('stu', 'POST', '/api/timetable', { title: 'x', scope: 'course', course_id: 1, starts: '2026-11-01T10:00:00Z', ends: '2026-11-01T11:00:00Z' })).status, 403);

    const notes = (await app.call('stu', 'GET', '/api/notifications')).body.notifications;
    assert.ok(notes.some((n) => /DEMO101/.test(n.title)), 'enrolled students are notified');

    // Private calendar feed
    const feed = await app.call('stu', 'POST', '/api/timetable/feed');
    const path = new URL(feed.body.url).pathname;
    const ics = await app.call('anon', 'GET', path);
    assert.equal(ics.status, 200);
    assert.match(ics.body, /BEGIN:VCALENDAR/);
    assert.match(ics.body, /SUMMARY:Algorithms/);
    await app.call('stu', 'POST', '/api/timetable/feed');
    assert.equal((await app.call('anon', 'GET', path)).status, 404, 'rotating the link disables the old one');
  } finally {
    await app.close();
  }
});

test('ICS import handles TZID, weekly RRULE with COUNT, folding and re-imports', async () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:lec-1@uni', 'SUMMARY:Statistics', 'LOCATION:Hörsaal 1\\, Weiden',
    'DTSTART;TZID=Europe/Berlin:20261103T081500', 'DTEND;TZID=Europe/Berlin:20261103T094500', 'RRULE:FREQ=WEEKLY;COUNT=3',
    'DESCRIPTION:Bring a calcu', ' lator', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:exam@uni', 'SUMMARY:Exam', 'DTSTART:20270120T090000Z', 'DTEND:20270120T110000Z', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const parsed = parseIcs(ics);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].location, 'Hörsaal 1, Weiden');
  assert.equal(parsed[0].notes, 'Bring a calculator');
  assert.equal(berlin(parsed[0].starts), '08:15');
  assert.equal(parsed[0].repeatWeeks, 1);
  assert.equal(parsed[0].count, 3);
  assert.match(toIcs([{ key: 'a', title: 'Long title '.repeat(10), starts: parsed[1].starts, ends: parsed[1].ends }]), /\r\n /, 'long lines are folded');

  const app = await startApp();
  try {
    await app.register('stu');
    const first = await app.call('stu', 'POST', '/api/timetable/import', { ics, scope: 'personal' });
    assert.deepEqual([first.body.imported, first.body.updated], [2, 0]);
    const second = await app.call('stu', 'POST', '/api/timetable/import', { ics, scope: 'personal' });
    assert.deepEqual([second.body.imported, second.body.updated], [0, 2]);
    const events = (await app.call('stu', 'GET', '/api/timetable?from=2026-11-01T00:00:00Z&to=2026-12-31T00:00:00Z')).body.events;
    assert.equal(events.filter((e) => e.title === 'Statistics').length, 3, 'COUNT limits occurrences');
  } finally {
    await app.close();
  }
});

test('spaced review schedules sensibly', () => {
  const fresh = { ease: 2.5, interval_days: 0, reps: 0, lapses: 0 };
  assert.equal(schedule(fresh, 'good').interval_days, 1);
  const second = schedule({ ...fresh, ...schedule(fresh, 'good') }, 'good');
  assert.equal(second.interval_days, 3);
  const third = schedule({ ...fresh, ...second, reps: 2 }, 'good');
  assert.equal(third.interval_days, 8);
  const again = schedule({ ...fresh, ...third, reps: 3 }, 'again');
  assert.equal(again.interval_days, 0);
  assert.equal(again.lapses, 1);
  assert.ok(again.ease < 2.5 && again.ease >= 1.3);
  assert.ok(schedule(fresh, 'easy').interval_days > schedule(fresh, 'good').interval_days);
});

test('review queue fills from ratings and missed checks; practice sets fall back to course checks', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const lec = await app.call('admin', 'POST', '/api/courses/1/lectures', { topic: 'Sorting' });
    const topic = await app.call('admin', 'POST', `/api/lectures/${lec.body.id}/topics`, { title: 'Merge sort' });
    await app.call('admin', 'POST', `/api/topics/${topic.body.id}/polls`, { question: 'Merge sort runs in?', options: ['O(n log n)', 'O(n²)'], correct: 0 });
    await app.register('stu');
    await app.call('stu', 'POST', '/api/courses/1/enroll');
    const course = (await app.call('stu', 'GET', '/api/courses/1')).body;
    const poll = course.lectures[0].topics[0].polls[0];
    assert.equal(poll.correct, undefined, 'answer hidden before answering');
    await app.call('stu', 'POST', `/api/topics/${topic.body.id}/respond`, { level: 2 });
    const answer = await app.call('stu', 'POST', `/api/polls/${poll.id}/answer`, { answer: 1 });
    assert.equal(answer.body.correct, false);

    const queue = (await app.call('stu', 'GET', '/api/review')).body;
    assert.equal(queue.stats.dueNow, 2);
    assert.ok(queue.due.some((d) => d.kind === 'poll' && d.answer === 'O(n log n)'));
    const graded = await app.call('stu', 'POST', `/api/review/${queue.due[0].id}`, { grade: 'good' });
    assert.equal(graded.body.item.interval, 1);
    assert.equal((await app.call('stu', 'GET', '/api/review')).body.stats.dueNow, 1);

    const pack = await app.call('stu', 'POST', '/api/revision', { course_id: 1 });
    assert.equal(pack.status, 201);
    assert.equal(pack.body.source, 'course');
    const result = await app.call('stu', 'POST', `/api/revision/${pack.body.id}/result`, { answers: [1] });
    assert.deepEqual([result.body.score, result.body.total], [0, 1]);
    const progress = (await app.call('stu', 'GET', '/api/progress')).body.courses[0];
    assert.deepEqual([progress.rated, progress.answered, progress.correct], [1, 1, 0]);
  } finally {
    await app.close();
  }
});

test('rotating check-in codes accept the current and previous window only', async () => {
  const secret = 'a'.repeat(32);
  const window = Math.floor(Date.now() / 30_000);
  const participation = createParticipation({ db: null });
  const session = { code_secret: secret };
  assert.equal(participation.verifyCode(session, codeFor(secret, window)), true);
  assert.equal(participation.verifyCode(session, codeFor(secret, window - 1)), true);
  assert.equal(participation.verifyCode(session, codeFor(secret, window - 3)), false);
  assert.equal(participation.verifyCode(session, '12'), false);

  const app = await startApp();
  try {
    await app.login('admin');
    await app.register('stu');
    await app.call('stu', 'POST', '/api/courses/1/enroll');
    const s = await app.call('admin', 'POST', '/api/participation', { course_id: 1, title: 'Week 1', require_code: true });
    assert.equal((await app.call('stu', 'POST', `/api/participation/${s.body.id}/checkin`, {})).status, 400);
    assert.equal((await app.call('stu', 'GET', `/api/participation/${s.body.id}/code`)).status, 403, 'students can’t read the code');
    const { code } = (await app.call('admin', 'GET', `/api/participation/${s.body.id}/code`)).body;
    const ok = await app.call('stu', 'POST', `/api/participation/${s.body.id}/checkin`, { code });
    assert.equal(ok.body.method, 'code_verified');
  } finally {
    await app.close();
  }
});
