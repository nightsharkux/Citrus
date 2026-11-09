'use strict';
/** Live lectures: the class pulse, signals from phones, notes, "explain what I just said", and who may do what. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { pulse, timeline, roughPatches, statusOf } = require('../src/modules/live/pulse');
const { createTranscripts } = require('../src/modules/live/transcript');

const at = (now, secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();

test('the pulse counts each student once, by their latest signal, inside the window', () => {
  const now = Date.parse('2026-11-10T10:00:00Z');
  const signals = [
    { user_id: 1, level: 3, created: at(now, 100) },
    { user_id: 1, level: 1, created: at(now, 20) }, // changed their mind: no longer lost
    { user_id: 2, level: 3, created: at(now, 30) },
    { user_id: 3, level: 2, created: at(now, 40) },
    { user_id: 4, level: 3, created: at(now, 600) }, // too old
  ];
  const p = pulse(signals, { now, enrolled: 20 });
  assert.deepEqual({ f: p.following, u: p.unsure, l: p.lost, a: p.answered }, { f: 1, u: 1, l: 1, a: 3 });
  assert.equal(p.enrolled, 20);
  assert.equal(p.status, 'trouble', 'half the answering students are struggling');
});

test('the room is only called when enough students have answered', () => {
  assert.equal(statusOf({ following: 1, unsure: 0, lost: 1 }), 'quiet');
  assert.equal(statusOf({ following: 9, unsure: 0, lost: 0 }), 'good');
  assert.equal(statusOf({ following: 7, unsure: 2, lost: 1 }), 'watch');
  assert.equal(statusOf({ following: 4, unsure: 2, lost: 4 }), 'trouble');
});

test('the timeline shows where the lecture went badly, and rough patches are runs of trouble', () => {
  const start = Date.parse('2026-11-10T10:00:00Z');
  const sig = (user, minute, level) => ({ user_id: user, level, created: new Date(start + (minute - 0.5) * 60000).toISOString() });
  // Everyone follows in minute 1; in minutes 3 and 4 most are lost; recovery in minute 6.
  const signals = [1, 2, 3, 4].map((u) => sig(u, 1, 1))
    .concat([1, 2, 3, 4].map((u) => sig(u, 3, u === 4 ? 1 : 3)))
    .concat([1, 2, 3, 4].map((u) => sig(u, 7, 1)));
  const line = timeline(signals, new Date(start).toISOString(), { now: start + 8 * 60000 });
  assert.equal(line.length, 8);
  assert.equal(line[0].status, 'good', 'everyone followed in the first minute');
  assert.equal(line[2].status, 'trouble');
  assert.equal(line[7].status, 'good');
  assert.deepEqual(roughPatches(line).map((p) => p.from), [3]);
});

test('speech is kept in memory only, newest minutes first, and can be cleared', () => {
  const t = createTranscripts();
  const now = Date.parse('2026-11-10T10:30:00Z');
  t.add(1, 'old remark', now - 20 * 60000);
  t.add(1, 'the gradient points uphill', now - 60000);
  t.add(1, 'so we subtract it', now - 30000);
  const text = t.recent(1, { minutes: 6, now });
  assert.match(text, /gradient points uphill/);
  assert.doesNotMatch(text, /old remark/);
  assert.equal(t.add(1, '   '), 0, 'silence is not stored');
  t.clear(1);
  assert.equal(t.recent(1, { now }), '');
});

function gateway(reply = 'You just explained gradient descent: you move against the slope. The class looks unsure, so try a hill example.') {
  const state = { last: null };
  return {
    state,
    async fetchImpl(url, options) {
      state.last = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: reply } }] });
    },
  };
}

test('a lecture runs from start to summary, with signals from enrolled students only', async () => {
  const fixture = gateway();
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key' }, fetchImpl: fixture.fetchImpl });
  try {
    await app.login('admin');
    await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
    const lecturerId = await app.lecturer('prof');
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' });
    await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
    for (const who of ['ann', 'ben', 'cem', 'dia']) {
      await app.register(who);
      await app.call(who, 'POST', `/api/courses/${course.body.id}/enroll`);
    }
    await app.register('outsider');
    await app.register('other');

    // Only the course's lecturer starts a lecture.
    assert.equal((await app.call('ann', 'POST', '/api/live/sessions', { course_id: course.body.id })).status, 403);
    assert.equal((await app.call('anon', 'POST', '/api/live/sessions', { course_id: course.body.id })).status, 401);

    // Notes: a text file stands in for a PDF; the same upload path reads pictures and PDFs.
    const note = await app.call('prof', 'POST', '/api/assistant/attachments', { name: 'week5.txt', mime: 'text/plain', data: Buffer.from('Week 5: gradient descent updates weights against the slope of the loss.').toString('base64') });
    assert.equal(note.status, 200);
    const started = await app.call('prof', 'POST', '/api/live/sessions', { course_id: course.body.id, title: 'Week 5', notes: [note.body.attachment.id] });
    assert.equal(started.status, 201);
    const sid = started.body.session.id;
    assert.equal(started.body.notes[0].name, 'week5.txt');
    assert.equal((await app.call('prof', 'POST', '/api/live/sessions', { course_id: course.body.id })).body.resumed, true, 'one running lecture per course');

    // Students see it; outsiders do not.
    assert.equal((await app.call('ann', 'GET', `/api/live/courses/${course.body.id}/active`)).body.session.id, sid);
    assert.equal((await app.call('outsider', 'GET', `/api/live/courses/${course.body.id}/active`)).status, 403);
    assert.equal((await app.call('outsider', 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 })).status, 403);
    assert.equal((await app.call('prof', 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 })).status, 403, 'the lecturer does not vote');

    // Signals
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/signal`, { level: 9 })).status, 400);
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 })).body.label, 'lost');
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/signal`, { level: 1 })).status, 409, 'not twice within seconds');
    await app.call('ben', 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 });
    await app.call('cem', 'POST', `/api/live/sessions/${sid}/signal`, { level: 2 });
    await app.call('dia', 'POST', `/api/live/sessions/${sid}/signal`, { level: 1 });

    const view = await app.call('prof', 'GET', `/api/live/sessions/${sid}`);
    assert.deepEqual({ l: view.body.pulse.lost, u: view.body.pulse.unsure, f: view.body.pulse.following, s: view.body.pulse.status }, { l: 2, u: 1, f: 1, s: 'trouble' });
    assert.equal(view.body.pulse.enrolled, 4);
    const mine = await app.call('ann', 'GET', `/api/live/sessions/${sid}`);
    assert.equal(mine.body.pulse, undefined, 'students never see the class pulse');
    assert.equal(mine.body.mine.level, 3, 'only their own signal');
    assert.ok(!JSON.stringify(mine.body).includes('ben'));

    // Speech goes in; the lecturer asks about "the last thing I said".
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/transcript`, { text: 'hi' })).status, 403);
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/transcript`, { text: 'So the gradient points uphill, which is why we subtract it.' });
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/ask`, { question: 'explain' })).status, 403);
    const asked = await app.call('prof', 'POST', `/api/live/sessions/${sid}/ask`, { question: 'Can you explain the last thing I said?' });
    assert.equal(asked.status, 200);
    assert.match(asked.body.answer, /gradient descent/);
    assert.equal(asked.body.heard, true);
    assert.deepEqual(asked.body.notes, ['week5.txt']);
    const sent = fixture.state.last;
    const system = sent.messages[0].content;
    const turn = sent.messages.at(-1).content;
    assert.match(turn, /<TRANSCRIPT>[\s\S]*gradient points uphill/);
    assert.match(turn, /Week 5: gradient descent/, 'the lecturer’s notes reach the model');
    assert.match(system, /"status":"trouble"/, 'and so does how the class is doing');
    assert.match(system, /Never name or guess which student/);
    assert.ok(!/ann|ben|cem|dia/i.test(system.split('<CLASS>')[1] || ''), 'the class block holds counts only');

    // Ending the lecture: summary, no more signals, speech forgotten.
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/end`)).status, 403);
    const ended = await app.call('prof', 'POST', `/api/live/sessions/${sid}/end`);
    assert.ok(ended.body.session.ended);
    assert.equal(ended.body.heard, 0, 'nothing of the speech is kept');
    assert.equal((await app.call('dia', 'POST', `/api/live/sessions/${sid}/signal`, { level: 1 })).status, 409);
    assert.equal((await app.call('ann', 'GET', `/api/live/courses/${course.body.id}/active`)).body.session, null);

    // Another lecturer cannot touch it.
    await app.lecturer('prof2');
    assert.equal((await app.call('prof2', 'POST', `/api/live/sessions/${sid}/end`)).status, 403);
  } finally {
    await app.close();
  }
});
