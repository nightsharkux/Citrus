'use strict';
/** Speech recognition learns each lecture's vocabulary: titles, topics and the standout terms in the notes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { lectureVocabulary, termsFrom, MAX_TERMS } = require('../src/modules/live/vocabulary');

const NOTES = 'Today we cover Gradient Descent and the Adam optimizer. Backpropagation computes gradients layer by layer. '
  + 'The ReLU activation helps; ReLU is cheap. We use PyTorch and TensorFlow. Das Verfahren heisst Rückwärtsableitung. '
  + 'Regularization prevents overfitting, and regularization is tuned with a validation set.';

test('standout terms come first: acronyms, names, capitalised phrases, repeated long words', () => {
  const terms = termsFrom(NOTES);
  for (const wanted of ['Gradient Descent', 'ReLU', 'PyTorch', 'TensorFlow', 'regularization']) {
    assert.ok(terms.map((t) => t.toLowerCase()).includes(wanted.toLowerCase()), `${wanted} in ${terms.join(', ')}`);
  }
  assert.ok(!terms.some((t) => /^(today|the|and|this)$/i.test(t)), 'common words are not boosted');
  assert.deepEqual(termsFrom(''), []);
});

test('the vocabulary puts titles first, has no duplicates and is capped', () => {
  const v = lectureVocabulary({ title: 'Week 5: Optimisation', course: { code: 'ML101', title: 'Machine Learning' }, topics: ['Learning rates', 'learning rates'], notes: [NOTES] });
  assert.deepEqual(v.slice(0, 4), ['Week 5: Optimisation', 'Machine Learning', 'ML101', 'Learning rates']);
  assert.equal(new Set(v.map((t) => t.toLowerCase())).size, v.length);
  const many = lectureVocabulary({ topics: Array.from({ length: 500 }, (_, i) => `Topic number ${i}`) });
  assert.equal(many.length, MAX_TERMS);
});

test('the recognition session carries the lecture’s terms for its lecturer only', async () => {
  const grants = [];
  const app = await startApp({
    env: { AI_GATEWAY_API_KEY: 'k', DEEPGRAM_API_KEY: 'dg-key', CAMPUS_STT_PROVIDER: 'deepgram' },
    fetchImpl: async (url) => {
      if (String(url).includes('/v1/auth/grant')) {
        grants.push(url);
        return Response.json({ access_token: 'temporary-token' });
      }
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  try {
    await app.login('admin');
    await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
    const lecturerId = await app.lecturer('prof');
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' });
    await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
    await app.register('stu');
    await app.call('stu', 'POST', `/api/courses/${course.body.id}/enroll`);
    await app.call('prof', 'POST', '/api/assistant/attachments', { name: 'n.txt', mime: 'text/plain', data: Buffer.from(NOTES).toString('base64') }).then(async (note) => {
      const live = await app.call('prof', 'POST', '/api/live/sessions', { course_id: course.body.id, title: 'Week 5 Optimisation', notes: [note.body.attachment.id] });
      app.liveId = live.body.session.id;
    });

    const keyterms = async (who, body) => {
      const r = await app.call(who, 'POST', '/api/speech/recognition-session', body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return new URL(r.body.url).searchParams.getAll('keyterm');
    };
    const mine = await keyterms('prof', { language: 'multi', live_session: app.liveId });
    assert.ok(mine.includes('Week 5 Optimisation') && mine.includes('Machine Learning'), mine.join(' | '));
    assert.ok(mine.includes('PyTorch'), 'terms mined from the uploaded notes');
    assert.ok(mine.includes('Citrus'), 'the campus basics stay');
    assert.ok(mine.length <= 100);

    const student = await keyterms('stu', { language: 'multi', live_session: app.liveId });
    assert.ok(!student.includes('PyTorch') && !student.includes('Week 5 Optimisation'), 'a student never receives the lecturer’s notes terms');
    const none = await keyterms('prof', { language: 'multi' });
    assert.ok(!none.includes('PyTorch'), 'without a lecture, only the basics');
    assert.equal((await app.call('anon', 'POST', '/api/speech/recognition-session', { language: 'multi' })).status, 401);
  } finally {
    await app.close();
  }
});
