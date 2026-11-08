'use strict';
/** The assistant starts out knowing the user's courses, exams, deadlines and free time, and only theirs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

function gateway() {
  const seen = [];
  return {
    seen,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      seen.push(body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Okay.' } }] }));
    },
  };
}

const at = (days, hour) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const hours = (iso, h) => new Date(Date.parse(iso) + h * 3_600_000).toISOString();

test('the system prompt carries the user\'s exams, deadlines, next class and free time, with a guide to use them', async () => {
  const fixture = gateway();
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key' }, fetchImpl: fixture.fetchImpl });
  try {
    await app.login('admin');
    await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
    await app.register('stu');
    await app.register('outsider');
    await app.call('stu', 'POST', '/api/courses/1/enroll');

    const exam = await app.call('admin', 'POST', '/api/timetable', { scope: 'course', course_id: 1, title: 'Final exam', kind: 'exam', starts: at(5, 9), ends: at(5, 11) });
    assert.equal(exam.status, 201, JSON.stringify(exam.body));
    await app.call('admin', 'POST', '/api/timetable', { scope: 'course', course_id: 1, title: 'Report hand-in', kind: 'deadline', starts: at(2, 17), ends: at(2, 18) });
    await app.call('stu', 'POST', '/api/timetable', { title: 'Dentist', kind: 'personal', starts: at(1, 13), ends: at(1, 14) });

    await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'am I ready?' });
    const system = fixture.seen.at(-1).messages[0].content;
    assert.match(system, /Exams and deadlines \(next 60 days\)/);
    assert.match(system, /Exam: Final exam/);
    assert.match(system, /Due: Report hand-in/);
    assert.match(system, /in 5 days/);
    assert.match(system, /Right now:/);
    assert.match(system, /Free time between 8:00 and 20:00/);
    assert.match(system, /Enrolled courses:\\n- /, 'the context is JSON-escaped inside its block');
    assert.match(system, /Use CONTEXT actively/);
    assert.ok(!/Dentist/.test(fixture.seen.at(-1).messages.at(-1).content), 'event titles never leak into the user turn');

    // Someone who is not in the course sees none of its exams.
    await app.call('outsider', 'POST', '/api/assistant/messages', { prompt: 'what is due?' });
    const other = fixture.seen.at(-1).messages[0].content;
    assert.ok(!/Final exam|Report hand-in|Dentist/.test(other));
    assert.match(other, /none in Campus OS/);
  } finally {
    await app.close();
  }
});

test('conversation starters come from the user\'s own situation', async () => {
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key' }, fetchImpl: gateway().fetchImpl });
  try {
    await app.login('admin');
    await app.register('stu');
    await app.register('outsider');
    await app.call('stu', 'POST', '/api/courses/1/enroll');
    await app.call('admin', 'POST', '/api/timetable', { scope: 'course', course_id: 1, title: 'Databases exam', kind: 'exam', starts: at(4, 10), ends: at(4, 12) });

    const mine = (await app.call('stu', 'GET', '/api/assistant')).body.starters;
    assert.ok(mine.some(([, text]) => /Databases exam/.test(text)), JSON.stringify(mine));
    assert.ok(mine.length <= 4);
    const theirs = (await app.call('outsider', 'GET', '/api/assistant')).body.starters;
    assert.ok(!theirs.some(([, text]) => /Databases exam/.test(text)));
    assert.equal((await app.call('anon', 'GET', '/api/assistant')).status, 401);
  } finally {
    await app.close();
  }
});
