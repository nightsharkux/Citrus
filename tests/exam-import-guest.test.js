'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExamRows } = require('../src/modules/timetable/exam-plan');
const { startApp } = require('./helpers');

const PAGE = `[Source: finaler_Pruefungsplan_Studiengang_DTM.pdf, PDF p. 1]
DTM  03.07.2026  90 Min.  09:00  Object-oriented Coding  Beham  keine, nur Unterlagen des Moodle-Kurses  E-Präsenz-Klausur  3  EDV-232
DTM  14.07.2026  90 Min.  15:30  Algorithms and Data Structures  Beham  keine  Präsenz-Klausur  1S, 2  MF
DTM  01.07.2026  90 Min.  15:45 -  AW-Spanisch als Wirtschaftssprache  Stock/Walczak  Präsenz-Klausur
DTM  Applied Image Processing  Geigenfeind  see vhb  semesterbegleitender Leistungsnachweis`;

test('exam rows keep the printed date, start, length and room', () => {
  const rows = parseExamRows(PAGE);
  assert.equal(rows.length, 3, 'courses without a date are left out');
  assert.deepEqual([rows[0].year, rows[0].month, rows[0].day, rows[0].time, rows[0].minutes, rows[0].room], [2026, 7, 3, '09:00', 90, 'EDV-232']);
  assert.equal(rows[0].module, 'Object-oriented Coding');
  assert.equal(rows[0].examiner, 'Beham');
  assert.equal(rows[1].room, 'MF');
  assert.equal(rows[2].module, 'AW-Spanisch als Wirtschaftssprache');
  assert.equal(rows[2].time, '15:45');
});

test('guests can continue without an account, and the assistant imports the plan into the calendar', async () => {
  const app = await startApp();
  try {
    const boot = await app.call(null, 'GET', '/api/bootstrap');
    assert.equal(boot.body.guests, true);
    const res = await app.call('guest', 'POST', '/api/guest');
    assert.equal(res.status, 201);
    assert.equal((await app.call('guest', 'GET', '/api/me')).status, 200);
    // the plan is in the knowledge library
    const admin = app.db.get("SELECT id, institution_id FROM users WHERE role = 'admin'");
    app.db.run("INSERT INTO institution_knowledge(institution_id, title, content, category, source_url, tags, volatility, external_id, updated) VALUES(?, 'plan', ?, 'exam schedule', '', 'CAMPUS_PDF_02', 'term-specific', 'CAMPUS_PDF_02:p1', ?)", admin.institution_id, PAGE, new Date().toISOString());
    const user = app.db.get("SELECT * FROM users WHERE auth_provider = 'guest'");
    const { createActionRunner } = require('../src/modules/assistant/actions');
    const runner = createActionRunner({ db: app.db, config: app.config, access: require('../src/services/access').createAccess(app.db), timetable: require('../src/modules/timetable/service').createTimetable({ db: app.db, timeZone: app.config.site.timezone }), audit: () => {} });
    const out = runner.run(user, { name: 'calendar.import', args: { programme: 'dtm' } });
    assert.equal(out.ok, true, out.error);
    const rows = app.db.all("SELECT starts, ends, kind, location FROM timetable_events WHERE owner_id = ? ORDER BY starts", user.id);
    assert.equal(rows.length, 3);
    assert.equal(rows[1].starts, '2026-07-03T07:00:00.000Z', '09:00 Berlin summer time');
    assert.equal(rows[1].kind, 'exam');
    assert.equal(runner.run(user, { name: 'calendar.import', args: { programme: 'dtm' } }).detail.startsWith('0 added'), true, 'importing twice adds nothing');
  } finally {
    await app.close();
  }
});
