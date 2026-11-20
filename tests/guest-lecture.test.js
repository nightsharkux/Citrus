'use strict';
/**
 * A guest (a lecture's QR code, no account) is a student with a throwaway login, so everything a student gets from a
 * lecture, a guest gets the same way, under the same rules: their own results, flags and notes for the parts they
 * struggled with, and no summary of the lecture.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

const SPEECH = 'So the gradient points uphill, which is why we subtract it from the weights. The learning rate decides how big each step is, and if it is too large we overshoot the minimum and the loss gets worse instead of better. Remember this for the exam.';

function gateway(seen) {
  return {
    async fetchImpl(url, options) {
      seen.push(options.body);
      const body = JSON.parse(options.body);
      const system = body.messages[0].content;
      let content = 'Fine.';
      if (/Do not quote the excerpt/.test(system)) content = 'Students probably lost the step of why the update goes against the gradient.';
      else if (/Return ONLY a JSON array of strings/.test(system)) content = '["The gradient points uphill, so weights move against it.", "Too large a learning rate overshoots the minimum.", "x"]';
      return Response.json({ choices: [{ message: { content } }] });
    },
  };
}
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('guests from a QR code get the same recap, record and notes as students, and no summary of the lecture', async () => {
  const seen = [];
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'k' }, fetchImpl: gateway(seen).fetchImpl });
  try {
    await app.login('admin');
    await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
    const lecturerId = await app.lecturer('prof');
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' });
    await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
    const lecture = await app.call('prof', 'POST', `/api/courses/${course.body.id}/lectures`, { topic: 'Week 5', room: 'HSG 001' });
    const token = (await app.call('prof', 'GET', `/api/live/lectures/${lecture.body.id}/link`)).body.token;
    const live = await app.call('prof', 'POST', '/api/live/sessions', { course_id: course.body.id, lecture_id: lecture.body.id });
    const sid = live.body.session.id;

    // Three guests: one is lost, one follows everything, one is lost and sends a flag.
    for (const who of ['lost', 'fine', 'asker']) {
      assert.equal((await app.call(who, 'POST', '/api/guest', { lecture: token, name: who })).status, 201);
      assert.equal((await app.call(who, 'POST', '/api/live/join', { token })).body.live, true);
    }
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/transcript`, { text: 'Welcome back. Today is about how a model actually learns from its mistakes, step by step, using a small worked example on the board.' });
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/transcript`, { text: SPEECH });
    assert.equal((await app.call('lost', 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 })).status, 200);
    assert.equal((await app.call('fine', 'POST', `/api/live/sessions/${sid}/signal`, { level: 1 })).status, 200);
    assert.equal((await app.call('asker', 'POST', `/api/live/sessions/${sid}/signal`, { level: 2 })).status, 200);
    const flag = await app.call('asker', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'confused', note: 'why subtract?' });
    assert.equal(flag.status, 201, 'a guest can flag a moment');
    await until(async () => (await app.call('prof', 'GET', `/api/live/sessions/${sid}/report`)).body.points?.length >= 2);
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/end`);

    // A guest who followed everything: results only, no summary, in the recap and in the file.
    const fine = (await app.call('fine', 'GET', `/api/live/sessions/${sid}/recap`)).body;
    assert.deepEqual(fine.points, []);
    assert.deepEqual(fine.struggles, []);
    assert.ok(fine.record.sections.every((s) => !s.points.length && !s.struggles.length));
    const fineTxt = (await (await app.call('fine', 'GET', `/api/live/sessions/${sid}/record.txt`, undefined, { raw: true })).text()).split('\n=== DATA ===\n')[1];
    assert.doesNotMatch(fineTxt, /key point|\[POINT|\[STRUGGLE|learning rate|against the gradient/i);

    // A guest who was lost: the key points of the part they were lost in, and their own notes about it.
    const lost = (await app.call('lost', 'GET', `/api/live/sessions/${sid}/recap`)).body;
    assert.ok(lost.points.length > 0, 'the part they were lost in comes with its key points');
    assert.ok(lost.record.targets.length > 0);
    assert.equal(JSON.stringify(lost).includes('gradient points uphill, which'), false, 'never the lecturer’s words');
    const mine = await app.call('lost', 'GET', `/api/live/sessions/${sid}/record.txt`, undefined, { raw: true });
    assert.equal(mine.status, 200);
    assert.match(await mine.text(), /MY LECTURE RECORD/);

    // Their flag is explained (private to them), and they can ask Citrus about their parts.
    const explained = await app.call('asker', 'POST', `/api/live/sessions/${sid}/flags/${flag.body.id}/explain`);
    assert.equal(explained.status, 200, JSON.stringify(explained.body));
    const asked = await app.call('lost', 'POST', `/api/live/sessions/${sid}/student-ask`, { question: 'What was I lost on?' });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.match(seen.at(-1), /Never give a summary, recap or list of key points/, 'and Citrus is told not to summarise');

    // Notes for a guest follow the same rule as for a student.
    seen.length = 0;
    assert.equal((await app.call('fine', 'POST', `/api/live/sessions/${sid}/ai-notes`)).status, 200);
    assert.doesNotMatch(seen.join(' '), /gradient points uphill|learning rate|against the gradient/, 'nothing about the parts the guest followed');
    seen.length = 0;
    assert.equal((await app.call('lost', 'POST', `/api/live/sessions/${sid}/ai-notes`)).status, 200);
    assert.match(seen.join(' '), /NOT lecture notes/);

    // Guests do not get what only the lecturer gets, and cannot read each other.
    for (const url of ['report', 'transcript.txt', 'recording.aac']) assert.equal((await app.call('lost', 'GET', `/api/live/sessions/${sid}/${url}`)).status, 403, url);
    assert.equal((await app.call('lost', 'POST', `/api/live/sessions/${sid}/quick-take`)).status, 403);
    assert.equal((await app.call('lost', 'POST', `/api/live/sessions/${sid}/review-chat`, { message: 'summarise' })).status, 403);
    assert.equal((await app.call('lost', 'POST', `/api/live/sessions/${sid}/ai-notes`, { student_id: 1 })).status, 403, 'not another student’s notes');
    assert.equal((await app.call('lost', 'GET', `/api/live/sessions/${sid}/recap`)).body.flags.length, 0, 'their own flags only');
  } finally {
    await app.close();
  }
});
