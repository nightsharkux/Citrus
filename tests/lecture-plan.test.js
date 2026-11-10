'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAcademicSnapshot, semesterIn } = require('../src/ai/academic-snapshot');

const file = 'resources/CampusOS_OTH_AW_Academic_Data_2026-11-08.txt';
const root = path.join(__dirname, '..');

test('spoken semesters are understood', () => {
  assert.equal(semesterIn('my next dtm class for the second semester summer start'), 2);
  assert.equal(semesterIn('3. Semester'), 3);
});

test('a timetable question is answered from the parsed grid with exact times, dates and the group', { skip: !fs.existsSync(path.join(root, file)) }, () => {
  const snap = createAcademicSnapshot({ root, file, read: (r, f) => fs.readFileSync(path.join(r, f), 'utf8') });
  const query = 'Give me an idea of my next dtm class for the second semester summer start\nim in group 2';
  const [hit] = snap.find(query, { now: new Date('2026-11-10T13:20:00Z') });
  assert.match(hit.title, /parsed from the printed grid/);
  assert.match(hit.content, /Tuesday: 15:45–19:00 English for Academic Purposes \(group II\) · room 140 · Mora/);
  assert.match(hit.content, /1\. Tuesday 10 November 2026 15:45–19:00 English for Academic Purposes/);
  assert.ok(!/group I\)|group III|group IV/.test(hit.content.split('Weekly:')[1]), 'other groups are left out');
  // without a semester the assistant is told to ask, not to guess
  const [ask] = snap.find('when is my next dtm class', { now: new Date('2026-11-10T13:20:00Z') });
  assert.match(ask.content, /Ask which semester/);
});
