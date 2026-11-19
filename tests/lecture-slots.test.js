'use strict';
/**
 * Ready-made lecture times. The periods come from the printed timetable of the DTM programme, so this checks them
 * against the timetable data itself, and checks the three sessions of the day are whole numbers of those periods.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { siteConfig, publicSite } = require('../config/site');
const { startApp } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const stripZero = (t) => t.replace(/^0/, '');

test('the teaching periods are the ones printed on the DTM timetable', () => {
  const site = siteConfig({ CAMPUS_EDITION: 'oth' });
  const text = fs.readFileSync(path.join(ROOT, site.academicSnapshot), 'utf8');
  // The printed time column: "8:15 1 / 9:45 / 2 10:00 / 11:30 / 3 11:45 / 13:15 / 4 14:00 / 15:30 / 15:45 5 / 17:15 / 17:30 6 / 19:00".
  const printed = '8:15 1 / 9:45 / 2 10:00 / 11:30 / 3 11:45 / 13:15 / 4 14:00 / 15:30 / 15:45 5 / 17:15 / 17:30 6 / 19:00';
  assert.ok(text.includes(printed), 'the timetable data still prints that time column');
  const times = printed.match(/\d{1,2}:\d{2}/g).map(stripZero);
  const expected = [0, 2, 4, 6, 8, 10].map((i) => [times[i], times[i + 1]]);
  assert.deepEqual(site.teachingPeriods.map((p) => [stripZero(p.from), stripZero(p.to)]), expected);
  assert.deepEqual(site.teachingPeriods.map((p) => p.n), [1, 2, 3, 4, 5, 6]);
});

test('the morning, afternoon and evening sessions are whole periods', () => {
  const site = siteConfig({ CAMPUS_EDITION: 'oth' });
  const byN = new Map(site.teachingPeriods.map((p) => [p.n, p]));
  for (const s of site.teachingSessions) {
    const first = byN.get(s.periods[0]);
    const last = byN.get(s.periods.at(-1));
    assert.equal(s.from, first.from, `${s.id} starts when its first period starts`);
    assert.equal(s.to, last.to, `${s.id} ends when its last period ends`);
  }
  const times = Object.fromEntries(site.teachingSessions.map((s) => [s.id, `${s.from}-${s.to}`]));
  assert.equal(times.morning, '08:15-11:30', 'periods 1 and 2');
  assert.equal(times.evening, '15:45-19:00', 'periods 5 and 6');
  // 13:15 is where period 3 ends; the next class on the timetable starts at 14:00.
  assert.equal(times.afternoon, '14:00-15:30', 'period 4');
});

test('the browser gets the periods; an edition without any gets none', async () => {
  assert.equal(publicSite(siteConfig({ CAMPUS_EDITION: 'oth' })).teachingSessions.length, 3);
  assert.deepEqual(publicSite(siteConfig({ CAMPUS_EDITION: 'general' })).teachingPeriods, []);
  const app = await startApp();
  try {
    const boot = await app.call(null, 'GET', '/api/bootstrap');
    assert.deepEqual(boot.body.site.teachingSessions.map((s) => s.id), ['morning', 'afternoon', 'evening']);
    assert.equal(boot.body.site.teachingPeriods.length, 6);
  } finally {
    await app.close();
  }
});

test('a lecture can be scheduled for a whole session, longer than the usual lengths', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const lecturerId = await app.lecturer('prof');
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' });
    await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
    const made = await app.call('prof', 'POST', `/api/courses/${course.body.id}/lectures`, { topic: 'Week 5', starts: '2026-11-24T07:15:00.000Z', duration_minutes: 195 });
    assert.equal(made.status, 201);
    const row = app.db.get('SELECT starts, ends FROM lectures WHERE topic = ?', 'Week 5');
    assert.equal(Date.parse(row.ends) - Date.parse(row.starts), 195 * 60_000, 'three hours fifteen, 8:15 to 11:30 in Berlin');
  } finally {
    await app.close();
  }
});

test('the slot arithmetic', async () => {
  const { slotLength, slotsOf, periodStarts, dayFor, lengthLabel, nextPeriodStart } = await import('../public/js/features/slot-times.js');
  const site = siteConfig({ CAMPUS_EDITION: 'oth' });
  assert.equal(slotLength({ from: '08:15', to: '11:30' }), 195);
  assert.equal(lengthLabel(195), '3 h 15 min');
  assert.equal(lengthLabel(90), '1 h 30 min');
  assert.equal(lengthLabel(45), '45 min');
  assert.equal(lengthLabel(120), '2 h');
  assert.deepEqual(slotsOf(site).sessions.map((s) => s.minutes), [195, 90, 195]);
  assert.deepEqual(periodStarts(site), ['08:15', '10:00', '11:45', '14:00', '15:45', '17:30']);
  assert.deepEqual(slotsOf({ teachingSessions: [{ from: '9:00', to: '10:00' }, { from: '11:00', to: '10:00' }, null] }), { sessions: [], periods: [] }, 'broken entries are ignored');
  assert.deepEqual(slotsOf({}), { sessions: [], periods: [] }, 'an edition without periods');

  const morning = { from: '08:15' };
  assert.equal(dayFor(morning, new Date(2026, 10, 19, 7, 0)), '2026-11-19', 'before it starts: today');
  assert.equal(dayFor(morning, new Date(2026, 10, 19, 9, 0)), '2026-11-20', 'once it has started: tomorrow');
  assert.equal(dayFor(morning, new Date(2026, 11, 31, 23, 0)), '2027-01-01', 'across the new year');
  assert.equal(nextPeriodStart(site, new Date(2026, 10, 19, 9, 50)), '10:00');
  assert.equal(nextPeriodStart(site, new Date(2026, 10, 19, 20, 0)), '08:15', 'after the last period: the first of the next day');
  assert.equal(nextPeriodStart({}, new Date()), null);
});
