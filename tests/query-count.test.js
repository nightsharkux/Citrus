'use strict';
/**
 * Pages make the same number of database calls however many lectures a course has. Each call is a round trip to
 * the hosted database (about 0.15 s on the live site), so a call per lecture made the course page, its content and
 * the term overview slower with every lecture of the term.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { createRecordSource } = require('../src/modules/live/record-source');

function countCalls(db) {
  let n = 0;
  // A batch is one round trip to the hosted database, so it counts once.
  for (const m of ['get', 'all', 'run', 'insert', 'exec', 'batch']) {
    const original = db[m].bind(db);
    db[m] = (...args) => {
      n += 1;
      return original(...args);
    };
  }
  return () => n;
}

async function lectures(app, courseId, count) {
  const ids = [];
  for (let k = 0; k < count; k += 1) {
    const s = await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: `Lecture ${ids.length + k}` });
    const sid = s.body.session.id;
    await app.call('ann', 'POST', '/api/live/join', { code: s.body.session.joinCode });
    await app.call('ann', 'POST', `/api/live/sessions/${sid}/share`, { share: true });
    for (const [who, level] of [['ann', 1 + (k % 3)], ['ben', 2]]) await app.call(who, 'POST', `/api/live/sessions/${sid}/signal`, { level });
    await app.call('ben', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'fast', note: `slow down ${k}` });
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/end`);
    ids.push(sid);
  }
  return ids;
}

test('the course page, its content and the term make a fixed number of database calls, however many lectures', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const lecturerId = await app.lecturer('prof');
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Signals', code: 'SIG1' });
    const courseId = course.body.id;
    await app.call('admin', 'POST', '/api/admin/assign', { course_id: courseId, lecturer_id: lecturerId });
    for (const who of ['ann', 'ben']) {
      await app.register(who);
      await app.call(who, 'POST', `/api/courses/${courseId}/enroll`);
    }
    const pages = [['prof', `/api/courses/${courseId}`], ['prof', `/api/courses/${courseId}/outline`], ['prof', `/api/courses/${courseId}/progress`],
      ['ann', `/api/courses/${courseId}`], ['ann', `/api/courses/${courseId}/outline`], ['ann', `/api/courses/${courseId}/progress`], ['prof', '/api/live/mine'],
      ['ann', '/api/bootstrap']];
    const calls = countCalls(app.db);
    const measure = async () => {
      const out = {};
      for (const [who, url] of pages) {
        const before = calls();
        assert.equal((await app.call(who, 'GET', url)).status, 200, url);
        out[`${who} ${url}`] = calls() - before;
      }
      return out;
    };
    await lectures(app, courseId, 2);
    const few = await measure();
    await lectures(app, courseId, 4);
    const many = await measure();
    assert.deepEqual(many, few, 'six lectures cost as many calls as two');
    for (const [page, n] of Object.entries(many)) assert.ok(n <= 15, `${page}: ${n} calls`);
    // The pages people wait on most: a round trip for who is asking, one for the course, one for everything else.
    assert.ok(many[`prof /api/courses/${courseId}`] <= 3, `course page: ${many[`prof /api/courses/${courseId}`]}`);
    assert.ok(many[`ann /api/courses/${courseId}`] <= 3);
    assert.ok(many[`ann /api/courses/${courseId}/outline`] <= 3);
  } finally {
    await app.close();
  }
});

test('loading a whole term at once gives exactly the records of loading each lecture', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const lecturerId = await app.lecturer('prof');
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Signals', code: 'SIG1' });
    await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
    for (const who of ['ann', 'ben']) {
      await app.register(who);
      await app.call(who, 'POST', `/api/courses/${course.body.id}/enroll`);
    }
    const ids = await lectures(app, course.body.id, 3);
    const sessions = ids.map((sid) => app.db.get('SELECT * FROM live_sessions WHERE id = ?', sid));
    const records = createRecordSource({ db: app.db, access: app.app.deps.access });
    assert.deepEqual(records.loadMany(sessions, { audience: 'lecturer' }), sessions.map((s) => records.load(s, { audience: 'lecturer', light: true })));
    const ann = app.db.get("SELECT id FROM users WHERE email = 'ann@test.invalid'").id;
    assert.deepEqual(records.loadMany(sessions, { audience: 'student', studentId: ann }), sessions.map((s) => records.load(s, { audience: 'student', studentId: ann })));
    assert.match(JSON.stringify(records.loadMany(sessions, { audience: 'lecturer' })), /Ann Person/, 'with the student who chose to show her name');
    assert.deepEqual(records.loadMany([], {}), []);
  } finally {
    await app.close();
  }
});

test('the live lecture screens take a few round trips, and the lecturer screen does not download the notes', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const lecturerId = await app.lecturer('prof');
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Signals', code: 'SIG1' });
    const courseId = course.body.id;
    await app.call('admin', 'POST', '/api/admin/assign', { course_id: courseId, lecturer_id: lecturerId });
    await app.register('ann');
    await app.call('ann', 'POST', `/api/courses/${courseId}/enroll`);
    const note = await app.call('prof', 'POST', '/api/assistant/attachments', { name: 'week1.txt', mime: 'text/plain', data: Buffer.from('Week 1 notes: '.repeat(2000)).toString('base64') });
    const s = await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, notes: [note.body.attachment.id] });
    const sid = s.body.session.id;
    const calls = countCalls(app.db);
    const cost = async (who, url) => {
      const before = calls();
      const r = await app.call(who, 'GET', url);
      assert.equal(r.status, 200, url);
      return { n: calls() - before, body: r.body };
    };
    const first = await cost('ann', `/api/live/courses/${courseId}/active`);
    assert.equal(first.body.present, 1, 'she is counted in the room');
    assert.equal(first.body.notes, 1);
    const again = await cost('ann', `/api/live/courses/${courseId}/active`);
    assert.ok(again.n <= 4, `student screen: ${again.n} round trips`);
    assert.equal(again.body.present, 1, 'once');
    const lecturer = await cost('prof', `/api/live/sessions/${sid}`);
    assert.ok(lecturer.n <= 4, `lecturer screen: ${lecturer.n} round trips`);
    assert.deepEqual(Object.keys(lecturer.body.notes[0]).sort(), ['id', 'kind', 'mime', 'name', 'size']);
    assert.ok(JSON.stringify(lecturer.body).length < 5000, 'the notes themselves are not sent with every refresh');
    assert.equal(lecturer.body.present, 1);
    assert.match(lecturer.body.session.joinLink, /^\/join\/[A-Za-z0-9_-]{12}$/);
  } finally {
    await app.close();
  }
});
