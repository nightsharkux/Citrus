'use strict';
/** After a lecture: where it went wrong for the lecturer, and a private recap for each student. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { parsePoints } = require('../src/modules/live/moments');
const { personalTimeline } = require('../src/modules/live/pulse');

const SPEECH = 'So the gradient points uphill, which is why we subtract it from the weights. The learning rate decides how big each step is, and if it is too large we overshoot the minimum and the loss gets worse instead of better. Remember this for the exam.';

function gateway() {
  return {
    async fetchImpl(url, options) {
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

test('key points are parsed defensively and a student’s own path is built minute by minute', () => {
  assert.deepEqual(parsePoints('Here: ["One long enough point.", 5, "tiny", "Second point is fine."] done'), ['One long enough point.', 'Second point is fine.']);
  assert.deepEqual(parsePoints('no json'), []);
  assert.deepEqual(parsePoints('[broken'), []);
  const start = Date.parse('2026-11-10T10:00:00Z');
  const sig = (minute, level) => ({ level, created: new Date(start + (minute - 0.5) * 60_000).toISOString() });
  const line = personalTimeline([sig(1, 1), sig(4, 3)], new Date(start).toISOString(), { now: start + 6 * 60_000 });
  assert.deepEqual(line.map((m) => m.level), [1, 1, 1, 3, 3, 3], 'an answer holds for three minutes, then it is unknown again');
  assert.equal(personalTimeline([], new Date(start).toISOString(), { now: start + 2 * 60_000 })[0].level, null);
});

test('the lecturer sees where it went wrong and what was said; a student sees only their own path and the key points', async () => {
  const fixture = gateway();
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'k' }, fetchImpl: fixture.fetchImpl });
  try {
    await app.login('admin');
    await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
    await app.register('prof', { role: 'lecturer' });
    const course = (await app.call('prof', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' })).body.id;
    for (const who of ['ann', 'ben', 'cem', 'dia']) {
      await app.register(who);
      await app.call(who, 'POST', `/api/courses/${course}/enroll`);
    }
    await app.register('outsider');
    const live = await app.call('prof', 'POST', '/api/live/sessions', { course_id: course, title: 'Week 5' });
    const sid = live.body.session.id;

    // The lecturer speaks; after enough speech the assistant picks up key points.
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/transcript`, { text: 'Welcome back. Today is about how a model actually learns from its mistakes, step by step, using a small worked example on the board.' });
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/transcript`, { text: SPEECH });
    // Then the class gets lost.
    await app.call('ann', 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 });
    await app.call('ben', 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 });
    await app.call('cem', 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 });
    await app.call('dia', 'POST', `/api/live/sessions/${sid}/signal`, { level: 1 });

    const report = await until(async () => {
      const r = (await app.call('prof', 'GET', `/api/live/sessions/${sid}/report`)).body;
      return r.struggles?.[0]?.note && r.points?.length >= 2 ? r : null;
    });
    assert.ok(report, 'a struggle moment with a note and key points appeared');
    assert.equal(report.struggles.length, 1, 'one moment per stretch of trouble, not one per tap');
    assert.match(report.struggles[0].excerpt, /gradient points uphill/, 'what was being said');
    assert.match(report.struggles[0].note, /against the gradient/);
    assert.deepEqual({ lost: report.struggles[0].lost, answered: report.struggles[0].answered }, { lost: 3, answered: 3 });
    assert.deepEqual(report.points.map((p) => p.text), ['The gradient points uphill, so weights move against it.', 'Too large a learning rate overshoots the minimum.']);
    assert.equal(report.course.code, 'ML101');
    assert.ok(report.timeline.length >= 1);

    // A student's recap: their own path, the class's trouble spots without the excerpt, and the key points.
    const recap = (await app.call('ann', 'GET', `/api/live/sessions/${sid}/recap`)).body;
    assert.equal(recap.mine.find((m) => m.level !== null).level, 3, 'her own answer');
    assert.equal(recap.signals, 1);
    assert.deepEqual(recap.points.map((p) => p.text), report.points.map((p) => p.text));
    assert.equal(recap.struggles.length, 1);
    assert.equal(JSON.stringify(recap).includes('gradient points uphill, which'), false, 'never the lecturer’s words');
    assert.equal(recap.struggles[0].excerpt, undefined);
    const dia = (await app.call('dia', 'GET', `/api/live/sessions/${sid}/recap`)).body;
    assert.equal(dia.mine.find((m) => m.level !== null).level, 1, 'each student sees only their own answers');

    // Access
    assert.equal((await app.call('ann', 'GET', `/api/live/sessions/${sid}/report`)).status, 403, 'students do not get the lecturer’s report');
    assert.equal((await app.call('outsider', 'GET', `/api/live/sessions/${sid}/recap`)).status, 403);
    assert.equal((await app.call('outsider', 'GET', `/api/live/sessions/${sid}/report`)).status, 403);
    assert.equal((await app.call('anon', 'GET', `/api/live/sessions/${sid}/recap`)).status, 401);

    // After the lecture, the lectures list points to the review; the lecturer also sees how often the class got lost.
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/end`);
    const profFeed = (await app.call('prof', 'GET', '/api/lectures/feed')).body.lectures.find((l) => l.topic === 'Week 5');
    assert.equal(profFeed.lastSession, sid);
    assert.equal(profFeed.struggles, 1);
    const annFeed = (await app.call('ann', 'GET', '/api/lectures/feed')).body.lectures.find((l) => l.topic === 'Week 5');
    assert.equal(annFeed.lastSession, sid);
    assert.equal(annFeed.struggles, undefined, 'students do not see how often the class got lost');
    assert.equal((await app.call('ann', 'GET', `/api/live/sessions/${sid}/recap`)).status, 200, 'the recap stays available afterwards');
  } finally {
    await app.close();
  }
});
