'use strict';
/** "Import my DTM courses": the weekly timetable parsed from the printed grid goes into the user's calendar. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { createAcademicSnapshot } = require('../src/ai/academic-snapshot');
const { createActionRunner } = require('../src/modules/assistant/actions');

test('the DTM semester 2 timetable (summer start) is added for every lecture day, as printed', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.register('stu');
  const user = app.db.get("SELECT * FROM users WHERE email = 'stu@test.invalid'");
  const programmes = createAcademicSnapshot({ root: app.config.root, file: app.config.site.academicSnapshot });
  const tt = programmes.load().timetables.find((x) => x.programme === 'DTM' && x.semester === 2 && x.term === 'SS');
  assert.ok(tt, 'the printed timetable parses');
  const runner = createActionRunner({
    db: app.db, config: app.config, access: require('../src/services/access').createAccess(app.db),
    timetable: require('../src/modules/timetable/service').createTimetable({ db: app.db, timeZone: app.config.site.timezone }),
    audit: () => {}, programmes, now: () => new Date('2026-11-10T09:00:00Z'),
  });

  assert.equal(runner.run(user, { name: 'calendar.classes', args: { programme: 'DTM' } }).ok, false, 'asks for the semester when it is not known');
  const out = runner.run(user, { name: 'calendar.classes', args: { programme: 'DTM', semester: 2, start: 'summer' } });
  assert.equal(out.ok, true, out.error);
  const rows = app.db.all("SELECT title, kind, location, notes, starts, ends FROM timetable_events WHERE owner_id = ? ORDER BY starts", user.id);
  assert.ok(rows.length > 20, `${rows.length} dates`);
  assert.ok(rows.every((r) => r.kind === 'lecture'));
  assert.ok(rows[0].starts >= '2026-11-10', 'nothing before today');
  assert.ok(!rows.some((r) => r.starts.startsWith('2026-12-25')), 'lecture-free days are skipped');

  // Every date is one of the printed weekly slots, in Berlin time.
  const slot = (iso) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
    return `${parts.weekday} ${parts.hour}:${parts.minute}`;
  };
  const printed = new Set(tt.entries.map((e) => `${e.day} ${e.start}`));
  assert.ok(rows.every((r) => printed.has(slot(r.starts))), 'times as printed');

  const groups = [...new Set(tt.entries.map((e) => e.group).filter(Boolean))];
  if (groups.length) {
    assert.match(out.warning, /split into groups/);
    assert.ok(!rows.some((r) => /\(group /.test(r.title)), 'group classes wait for the group');
    const withGroup = runner.run(user, { name: 'calendar.classes', args: { programme: 'DTM', semester: 2, start: 'SS', group: `Group ${groups[0]}` } });
    assert.equal(withGroup.ok, true, withGroup.error);
    assert.ok(app.db.get("SELECT 1 FROM timetable_events WHERE owner_id = ? AND title LIKE ?", user.id, `%(group ${groups[0]})`));
  }
  const again = runner.run(user, { name: 'calendar.classes', args: { programme: 'DTM', semester: 2, start: 'SS' } });
  assert.match(again.title, /already there/, 'importing twice adds nothing');

  // Undo takes the first import back out; the group classes added afterwards stay.
  const before = app.db.get('SELECT COUNT(*) n FROM timetable_events WHERE owner_id = ?', user.id).n;
  assert.equal(out.undo.ids.length, rows.length);
  runner.undo(user, out);
  assert.equal(app.db.get('SELECT COUNT(*) n FROM timetable_events WHERE owner_id = ?', user.id).n, before - rows.length);
});
