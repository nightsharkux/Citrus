'use strict';
/** Lecture insights: key points from live captions, student marks, study notes, privacy and the no-AI fallback. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { parseInsights, dropRepeats, basicInsights } = require('../src/modules/insights/extract');

const SPEECH = [
  'Today we look at quadratic equations. A quadratic equation is defined as an equation of the form a x squared plus b x plus c equals zero where a is not zero, and we call the three numbers the coefficients of the equation.',
  'Remember that the discriminant is important, because it tells you how many real solutions exist. The discriminant is b squared minus four a c, and you will see it again in the exam next week.',
  'For example, suppose the equation is x squared minus five x plus six equals zero, then a is one, b is minus five and c is six. The assignment on this topic is due on Friday, please submit it through the course page.',
];

function gateway() {
  const state = { calls: [] };
  return {
    state,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      const system = body.messages[0].content;
      state.calls.push(system);
      let reply = 'ok';
      if (/listening to the lecture/.test(system)) {
        reply = `Here you go:\n\`\`\`json\n${JSON.stringify({
          topic: 'Quadratic equations',
          points: [
            { kind: 'definition', title: 'Quadratic equation', body: 'An equation a x² + b x + c = 0 with a not zero.', formula: 'ax^2+bx+c=0', importance: 3 },
            { kind: 'important', title: 'The discriminant counts solutions', body: 'It tells you how many real solutions exist.', formula: '', importance: 3 },
            { kind: 'announcement', title: 'Assignment due Friday', body: 'Submit it through the course page.', formula: '', importance: 2 },
            { kind: 'hologram', title: 'Unknown kind becomes a concept', body: 'Still kept.', importance: 99 },
            { kind: 'concept', title: '', body: '' },
          ],
        })}\n\`\`\``;
      } else if (/write study notes/.test(system)) {
        reply = JSON.stringify({
          summary: '- Quadratics have the form $ax^2+bx+c=0$.\n- The discriminant decides the number of roots.',
          glossary: [{ term: 'Discriminant', meaning: 'b² − 4ac' }],
          questions: [{ question: 'What does a negative discriminant mean?', answer: 'No real solutions.' }],
          followUps: ['Revisit how the discriminant is used.'],
        });
      }
      return body.stream ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`) : new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    },
  };
}

async function lecture(app, { ai = true } = {}) {
  await app.login('admin');
  if (ai) await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
  const lecturerId = await app.lecturer('prof');
  const space = (await app.call('prof', 'POST', '/api/workspaces', { title: 'Algebra lecture', kind: 'lecture' })).body;
  for (const who of ['ann', 'bob']) {
    await app.register(who);
    await app.call(who, 'POST', '/api/workspaces/join', { code: space.joinCode });
  }
  await app.register('outsider');
  await app.call('prof', 'POST', `/api/workspaces/${space.id}/live`, { active: true, reset: true });
  for (const line of SPEECH) await app.call('prof', 'POST', `/api/workspaces/${space.id}/captions`, { text: line });
  return { space, lecturerId, base: `/api/workspaces/${space.id}` };
}

test('the model reply is parsed defensively and repeats are dropped', () => {
  const parsed = parseInsights('Sure!\n```json\n{"topic":"T","points":[{"kind":"formula","title":"Area","body":"x","formula":"$A=\\\\pi r^2$","importance":9},{"kind":"nope","title":"Odd one","body":"kept as a concept"},"junk",{"title":""}]}\n```');
  assert.equal(parsed.topic, 'T');
  assert.equal(parsed.points.length, 2);
  assert.equal(parsed.points[0].importance, 3, 'importance is clamped');
  assert.ok(!parsed.points[0].formula.includes('$'), 'dollar signs are removed from formulas');
  assert.equal(parsed.points[1].kind, 'concept');
  assert.equal(parseInsights('no json here'), null);
  assert.equal(parseInsights('{"points": "wrong"}'), null);
  const fresh = dropRepeats([{ title: 'The discriminant counts roots', body: 'x' }, { title: 'Completely new idea', body: 'y' }], ['Discriminant counts the roots']);
  assert.deepEqual(fresh.map((p) => p.title), ['Completely new idea']);
});

test('without an AI, a rule-based pass still finds definitions, emphasis, announcements and examples', () => {
  const { points } = basicInsights(SPEECH.join(' '));
  const kinds = points.map((p) => p.kind);
  assert.ok(points.length >= 3 && points.length <= 5);
  assert.ok(kinds.includes('definition') || kinds.includes('important'));
  assert.ok(kinds.includes('announcement'), 'the Friday assignment is picked up');
  assert.ok(points.every((p) => p.source === 'basic' && p.title && p.importance >= 2));
  assert.deepEqual(basicInsights('hmm okay right so um').points, []);
});

test('key points are captured in small steps, shared live, and de-duplicated', async () => {
  const gw = gateway();
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: gw.fetchImpl });
  try {
    const { base } = await lecture(app);
    const first = await app.call('prof', 'POST', `${base}/insights/extract`, {});
    assert.equal(first.status, 200);
    assert.equal(first.body.added.length, 4, 'the empty point is discarded, the rest kept');
    assert.equal(first.body.added[3].kind, 'concept');
    assert.equal(first.body.added[3].importance, 3);
    assert.equal(first.body.topic, 'Quadratic equations');
    assert.match(gw.state.calls[0], /listening to the lecture/);

    // Nothing new was said: nothing is looked at again, and the model is not called.
    const again = await app.call('prof', 'POST', `${base}/insights/extract`, { force: true });
    assert.equal(again.body.added.length, 0);
    assert.equal(again.body.waiting, 'short');
    assert.equal(gw.state.calls.length, 1);
    const quick = await app.call('prof', 'POST', `${base}/insights/extract`, {});
    assert.equal(quick.body.waiting, 'recent', 'looks are spaced out');

    // More speech with the same ideas adds nothing twice.
    for (const line of SPEECH) await app.call('prof', 'POST', `${base}/captions`, { text: line });
    const repeat = await app.call('prof', 'POST', `${base}/insights/extract`, { force: true });
    assert.equal(repeat.body.added.length, 0, 'points that repeat earlier ones are dropped');
    assert.match(gw.state.calls.at(-1), /listening to the lecture/);

    const seen = await app.call('ann', 'GET', `${base}/insights`);
    assert.equal(seen.body.insights.length, 4);
    assert.equal(seen.body.canManage, false);
    assert.equal(seen.body.insights[0].formula, 'ax^2+bx+c=0');
  } finally {
    await app.close();
  }
});

test('students save points and mark them unclear; only the lecturer sees the counts', async () => {
  const gw = gateway();
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: gw.fetchImpl });
  try {
    const { base } = await lecture(app);
    await app.call('prof', 'POST', `${base}/insights/extract`, {});
    const [p1, p2] = (await app.call('ann', 'GET', `${base}/insights`)).body.insights;

    assert.equal((await app.call('ann', 'POST', `${base}/insights/${p1.id}/mark`, { mark: 'saved' })).status, 200);
    await app.call('ann', 'POST', `${base}/insights/${p2.id}/mark`, { mark: 'unclear' });
    await app.call('bob', 'POST', `${base}/insights/${p2.id}/mark`, { mark: 'unclear' });
    await app.call('bob', 'POST', `${base}/insights/${p2.id}/mark`, { mark: 'unclear' });
    assert.equal((await app.call('ann', 'POST', `${base}/insights/${p1.id}/mark`, { mark: 'applauded' })).status, 400);

    const ann = (await app.call('ann', 'GET', `${base}/insights`)).body.insights;
    assert.equal(ann[0].saved, true);
    assert.equal(ann[1].unclear, true);
    assert.equal(ann[1].unclearCount, undefined, 'students never see how others voted');
    const bob = (await app.call('bob', 'GET', `${base}/insights`)).body.insights;
    assert.equal(bob[0].saved, false, 'marks are personal');

    const prof = (await app.call('prof', 'GET', `${base}/insights`)).body.insights;
    assert.equal(prof[1].unclearCount, 2, 'the lecturer sees how many found it unclear, repeated taps counted once each');
    assert.equal(prof[1].unclear, false);

    await app.call('ann', 'POST', `${base}/insights/${p2.id}/mark`, { mark: 'unclear', on: false });
    assert.equal((await app.call('prof', 'GET', `${base}/insights`)).body.insights[1].unclearCount, 1);
  } finally {
    await app.close();
  }
});

test('only the speaker can capture, add, remove or publish; outsiders see nothing', async () => {
  const gw = gateway();
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: gw.fetchImpl });
  try {
    const { base } = await lecture(app);
    await app.call('prof', 'POST', `${base}/insights/extract`, {});
    const id = (await app.call('ann', 'GET', `${base}/insights`)).body.insights[0].id;

    for (const [method, url, body] of [['POST', `${base}/insights/extract`, {}], ['POST', `${base}/insights`, { title: 'Pinned by a student' }], ['DELETE', `${base}/insights/${id}`], ['POST', `${base}/insights/digest`, {}]]) {
      assert.equal((await app.call('ann', method, url, body)).status, 403, `${method} ${url}`);
    }
    for (const [method, url, body] of [['GET', `${base}/insights`], ['POST', `${base}/insights/${id}/mark`, { mark: 'saved' }], ['POST', `${base}/insights/extract`, {}]]) {
      assert.equal((await app.call('outsider', method, url, body)).status, 403, `outsider ${method} ${url}`);
    }

    const pinned = await app.call('prof', 'POST', `${base}/insights`, { title: 'Exam covers chapters 1 to 3', kind: 'announcement' });
    assert.equal(pinned.status, 201);
    assert.equal(pinned.body.insight.source, 'lecturer');
    assert.equal((await app.call('prof', 'DELETE', `${base}/insights/${id}`)).status, 200);
    assert.equal((await app.call('prof', 'DELETE', `${base}/insights/${id}`)).status, 404);
  } finally {
    await app.close();
  }
});

test('study notes are made once, shared with the space, and follow-ups stay with the lecturer', async () => {
  const gw = gateway();
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: gw.fetchImpl });
  try {
    const { base } = await lecture(app);
    await app.call('prof', 'POST', `${base}/insights/extract`, {});
    assert.equal((await app.call('ann', 'GET', `${base}/insights`)).body.digest, null);

    const made = await app.call('prof', 'POST', `${base}/insights/digest`, {});
    assert.equal(made.status, 200);
    assert.equal(made.body.digest.source, 'ai');
    assert.equal(made.body.digest.glossary[0].term, 'Discriminant');
    assert.equal(made.body.digest.questions.length, 1);

    const student = (await app.call('ann', 'GET', `${base}/insights`)).body.digest;
    assert.match(student.summary, /discriminant/i);
    assert.equal(student.followUps, undefined, 'follow-ups are for the lecturer only');
    assert.deepEqual((await app.call('prof', 'GET', `${base}/insights`)).body.digest.followUps, ['Revisit how the discriminant is used.']);

    const inbox = (await app.call('ann', 'GET', '/api/notifications')).body;
    assert.ok(JSON.stringify(inbox).includes('study notes ready'), 'members are told the notes are ready');
  } finally {
    await app.close();
  }
});

test('with no AI connected the lecture still gets basic key points and an outline, clearly labelled', async () => {
  const app = await startApp();
  try {
    const { base } = await lecture(app, { ai: false });
    const got = await app.call('prof', 'POST', `${base}/insights/extract`, {});
    assert.ok(got.body.added.length >= 3);
    assert.ok(got.body.added.every((p) => p.source === 'basic'));
    const digest = await app.call('prof', 'POST', `${base}/insights/digest`, {});
    assert.equal(digest.body.digest.source, 'basic');
    assert.deepEqual(digest.body.digest.questions, [], 'no invented quiz without an AI');
  } finally {
    await app.close();
  }
});

test('the assistant knows the key points of your own lectures, and only yours', async () => {
  const gw = gateway();
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: gw.fetchImpl });
  try {
    const { base } = await lecture(app);
    await app.call('prof', 'POST', `${base}/insights/extract`, {});
    // The personal context is built per user: check it directly.
    const mine = app.app.deps.buildContext({ id: app.db.get("SELECT id FROM users WHERE email = 'ann@test.invalid'").id, role: 'student', institution_id: 1, name: 'Ann' });
    assert.match(mine, /Algebra lecture\] Quadratic equation/);
    const theirs = app.app.deps.buildContext({ id: app.db.get("SELECT id FROM users WHERE email = 'outsider@test.invalid'").id, role: 'student', institution_id: 1, name: 'Out' });
    assert.ok(!/Algebra lecture/.test(theirs), 'someone outside the space gets nothing from it');
  } finally {
    await app.close();
  }
});
