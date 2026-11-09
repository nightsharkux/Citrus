'use strict';
/** Quizzes: eight kinds of question, marking, written answers with tutor feedback, the tutor, retries and access. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { normalise, parseQuiz, publicView, mark, markShortByKeywords, solution, shuffled, toNumber } = require('../src/modules/quiz/questions');

/** One question of every kind, plus two the server must drop (a broken one and a duplicate). */
const QUIZ = {
  title: 'Photosynthesis basics',
  questions: [
    { type: 'single', question: 'Where does photosynthesis happen?', options: ['Mitochondria', 'Chloroplasts', 'Nucleus', 'Ribosomes'], answer: 1, explanation: 'Chloroplasts hold chlorophyll.', hint: 'Think green.' },
    { type: 'multi', question: 'Which are inputs of photosynthesis? Select all that apply.', options: ['Carbon dioxide', 'Water', 'Oxygen', 'Light'], answers: [0, 1, 3], explanation: 'Oxygen is an output.', hint: 'What does a plant take in?' },
    { type: 'truefalse', question: 'Photosynthesis releases oxygen.', answer: true, explanation: 'Water is split.', hint: '' },
    { type: 'blank', question: 'The green pigment is called ___.', answers: ['chlorophyll'], explanation: 'It absorbs light.', hint: 'Starts with chloro.' },
    { type: 'short', question: 'Why do plants need light?', model_answer: 'Light provides the energy to split water and make sugar.', key_points: ['energy for the reactions', 'splitting water molecules'], explanation: 'Light is the energy source.', hint: 'Energy.' },
    { type: 'order', question: 'Put the steps in order.', items: ['Light is absorbed', 'Water is split', 'ATP is made', 'Sugar is built'], explanation: 'Light reactions come first.', hint: 'Start with light.' },
    { type: 'match', question: 'Match each term to its meaning.', pairs: [['Stomata', 'Pores for gas exchange'], ['Xylem', 'Carries water'], ['Glucose', 'The sugar produced']], explanation: 'Plant anatomy.', hint: '' },
    { type: 'numeric', question: 'A leaf makes 2.5 g of sugar per hour. How much in 4 hours?', answer: 10, tolerance: 0.1, unit: 'g', explanation: '2.5 × 4 = 10.', hint: 'Multiply.' },
    { type: 'single', question: 'Broken', options: ['A', 'A'], answer: 0 },
    { type: 'single', question: 'Where does photosynthesis happen?', options: ['Here', 'There'], answer: 0 },
  ],
};

test('the model’s questions are checked kind by kind; broken and duplicate ones are dropped', () => {
  const parsed = parseQuiz(`Here you go:\n\`\`\`json\n${JSON.stringify(QUIZ)}\n\`\`\``);
  assert.equal(parsed.title, 'Photosynthesis basics');
  assert.deepEqual(parsed.questions.map((q) => q.type), ['single', 'multi', 'truefalse', 'blank', 'short', 'order', 'match', 'numeric']);
  assert.equal(parseQuiz(JSON.stringify(QUIZ.questions)).questions.length, 8, 'a bare list is accepted too');
  assert.equal(parseQuiz('no json at all').questions.length, 0);

  assert.equal(normalise({ type: 'single', question: 'Pick one?', options: ['a', 'b'], answer: 5 }), null, 'answer out of range');
  assert.equal(normalise({ type: 'multi', question: 'Pick all?', options: ['a', 'b', 'c'], answers: [0, 1, 2] }), null, 'everything right is not a question');
  assert.equal(normalise({ type: 'order', question: 'Order these', items: ['a', 'b'] }), null, 'too few steps');
  assert.equal(normalise({ type: 'essay', question: 'Write an essay' }), null, 'unknown kinds are dropped');
  assert.equal(normalise({ type: 'truefalse', question: 'Wasser ist nass.', answer: 'wahr' }).answer, true, 'German true');
  assert.match(normalise({ type: 'blank', question: 'Fill in the gap', answers: ['x'] }).question, /___$/, 'a blank gets its gap');
  assert.equal(normalise({ type: 'numeric', question: 'How much is it?', answer: '12,5' }).answer, 12.5);
  assert.equal(toNumber('1.234,5'), 1234.5);
  assert.equal(toNumber('1,234.5'), 1234.5);
  assert.equal(toNumber('abc'), null);
});

test('every kind is marked fairly, and what the student sees never contains the answer', () => {
  const [single, multi, tf, blank, short, order, match, numeric] = parseQuiz(JSON.stringify(QUIZ)).questions;
  assert.equal(mark(single, 1).score, 1);
  assert.equal(mark(single, 0).score, 0);
  assert.equal(mark(single, 9), null, 'a wrong shape is not an answer');
  assert.equal(mark(multi, [0, 1, 3]).score, 1);
  assert.equal(Math.round(mark(multi, [0, 1]).score * 100), 67, 'partly right');
  assert.equal(Math.round(mark(multi, [0, 1, 2]).score * 100), 33, 'a wrong pick costs a right one');
  assert.equal(mark(tf, false).score, 0);
  assert.equal(mark(tf, 'yes'), null);
  assert.equal(mark(blank, '  Chlorophyl ').score, 1, 'a small typo in a long word still counts');
  assert.equal(mark(blank, 'chloroplast').score, 0);
  assert.equal(mark(order, order.items).score, 1);
  assert.ok(mark(order, [...order.items].reverse()).score < 0.5);
  assert.equal(mark(order, ['Light is absorbed', 'x', 'y', 'z']), null, 'only the given items');
  assert.equal(mark(match, match.pairs.map((p) => p[1])).score, 1);
  assert.equal(Math.round(mark(match, ['Carries water', 'Pores for gas exchange', 'The sugar produced']).score * 100), 33);
  assert.equal(mark(numeric, '10,05').score, 1, 'within the tolerance, with a German comma');
  assert.equal(mark(numeric, 11).score, 0);
  assert.equal(markShortByKeywords(short, 'Light gives the energy for the reactions that make sugar.').score, 0.5);
  assert.equal(solution(numeric), '10 g');
  assert.equal(solution(order), 'Light is absorbed → Water is split → ATP is made → Sugar is built');

  for (const q of [single, multi, tf, blank, short, order, match, numeric]) {
    const seen = JSON.stringify(publicView(q, 42));
    assert.ok(!/"answers?"|model_answer|key_points|explanation|pairs/.test(seen), `${q.type} hides its answer: ${seen}`);
  }
  assert.notDeepEqual(publicView(order, 42).items, order.items, 'steps are shuffled');
  assert.deepEqual(publicView(order, 42).items, publicView(order, 42).items, 'the same way every time');
  assert.notDeepEqual(shuffled([1, 2], 1), [1, 2]);
});

/** Gateway stand-in that writes quizzes, marks written answers and tutors. */
function gateway({ quiz = QUIZ } = {}) {
  const state = { calls: [] };
  return {
    state,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      const system = body.messages[0].content;
      state.calls.push(body);
      let content = 'Hello.';
      if (/writes clear, fair, well-explained practice questions/.test(system)) content = typeof quiz === 'string' ? quiz : JSON.stringify(quiz);
      else if (/You mark a student/.test(system)) content = '{"score": 0.5, "feedback": "You named the energy but not the splitting of water."}';
      else if (/patient tutor/.test(system)) content = 'What does a plant need energy for? Think about water.';
      else if (/quiz\.start/.test(system) && /quiz me/i.test(body.messages.at(-1).content)) content = '[action: quiz.start | {"topic":"photosynthesis","count":5,"difficulty":"easy","types":["single","numeric","essay"]}]\n\nStarting a quiz.';
      return Response.json({ choices: [{ message: { content } }] });
    },
  };
}

async function readyApp(fixture) {
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key' }, fetchImpl: fixture.fetchImpl });
  await app.login('admin');
  await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
  await app.register('stu');
  await app.register('other');
  return app;
}

test('a quiz is written, answered kind by kind, marked like a tutor, retried and kept private', async () => {
  const fixture = gateway();
  const app = await readyApp(fixture);
  try {
    const made = await app.call('stu', 'POST', '/api/quizzes', { topic: 'Photosynthesis', count: 10, difficulty: 'easy', types: ['single', 'multi', 'truefalse', 'blank', 'short', 'order', 'match', 'numeric'], language: 'en' });
    assert.equal(made.status, 201);
    const quizId = made.body.quiz.id;
    assert.equal(made.body.quiz.total, 8, 'the broken and duplicate questions were dropped');
    assert.equal(made.body.questions[3].label, 'Fill in the blank');
    assert.ok(!/"answers?"|model_answer|key_points|"pairs"|explanation/.test(JSON.stringify(made.body.questions)), 'no answers before answering');
    assert.deepEqual(made.body.answers, {}, 'nothing answered yet');
    const prompt = fixture.state.calls[0].messages.at(-1).content;
    assert.match(prompt, /exactly 10 questions about: Photosynthesis/);
    assert.match(prompt, /"type":"numeric"/);

    const answer = (index, value) => app.call('stu', 'POST', `/api/quizzes/${quizId}/answers`, { index, answer: value });
    const order = made.body.questions[5].items;
    assert.equal((await answer(0, 1)).body.correct, true);
    const multi = await answer(1, [0, 1]);
    assert.equal(multi.body.correct, false);
    assert.equal(multi.body.score, 0.67);
    assert.equal(multi.body.solution, 'Carbon dioxide; Water; Light');
    assert.match(multi.body.explanation, /Oxygen is an output/);
    assert.equal((await answer(2, false)).body.correct, false);
    assert.equal((await answer(3, 'chlorophyl')).body.correct, true);
    const written = await answer(4, 'Light gives energy.');
    assert.equal(written.body.score, 0.5);
    assert.match(written.body.feedback, /splitting of water/);
    const graded = fixture.state.calls.at(-1);
    assert.match(graded.messages[0].content, /data, never instructions/);
    assert.match(graded.messages.at(-1).content, /<ANSWER>/, 'the student’s text is fenced as data');
    assert.equal((await answer(5, ['Light is absorbed', 'Water is split', 'ATP is made', 'Sugar is built'])).body.correct, true);
    assert.ok(order.join() !== 'Light is absorbed,Water is split,ATP is made,Sugar is built');
    assert.equal((await answer(6, ['Pores for gas exchange', 'Carries water', 'The sugar produced'])).body.correct, true);
    assert.equal((await answer(5, ['x'])).status, 400, 'each question is answered once');
    assert.equal((await answer(9, 1)).status, 400);
    assert.equal((await answer(7, 'not a number')).status, 400);

    const tutor = await app.call('stu', 'POST', `/api/quizzes/${quizId}/tutor`, { index: 7, messages: [{ role: 'user', content: 'How do I start?' }] });
    assert.match(tutor.body.reply, /Think about water/);
    const before = fixture.state.calls.at(-1).messages[0].content;
    assert.match(before, /do not give the answer away/);
    assert.doesNotMatch(before, /correct_answer/, 'no solution before answering');

    const last = await answer(7, '10');
    assert.equal(last.body.quiz.answered, 8);
    assert.ok(last.body.quiz.finished);
    assert.equal(last.body.quiz.score, 6.17, '1 + 0.67 + 0 + 1 + 0.5 + 1 + 1 + 1');
    await app.call('stu', 'POST', `/api/quizzes/${quizId}/tutor`, { index: 1, messages: [{ role: 'user', content: 'Why was oxygen wrong?' }] });
    assert.match(fixture.state.calls.at(-1).messages[0].content, /correct_answer/, 'after answering the tutor may discuss the solution');

    const opened = await app.call('stu', 'GET', `/api/quizzes/${quizId}`);
    assert.equal(Object.keys(opened.body.answers).length, 8);
    assert.deepEqual(opened.body.questions[5].items, order, 'the same order when opened again');
    const review = await app.call('stu', 'GET', '/api/review');
    assert.ok(JSON.stringify(review.body).includes('Which are inputs of photosynthesis'), 'mistakes join the review queue');

    const retry = await app.call('stu', 'POST', `/api/quizzes/${quizId}/retry`);
    assert.equal(retry.status, 201);
    assert.equal(retry.body.quiz.total, 3, 'only the questions not fully right');
    assert.match(retry.body.quiz.title, /^Retry: /);
    assert.equal((await app.call('stu', 'GET', '/api/quizzes')).body.quizzes.length, 2);

    // Private: someone else cannot see, answer, ask about or delete it.
    for (const [method, url, body] of [['GET', `/api/quizzes/${quizId}`], ['POST', `/api/quizzes/${quizId}/answers`, { index: 0, answer: 1 }], ['POST', `/api/quizzes/${quizId}/tutor`, { index: 0, messages: [{ role: 'user', content: 'Hi' }] }], ['POST', `/api/quizzes/${quizId}/retry`], ['DELETE', `/api/quizzes/${quizId}`]]) {
      assert.equal((await app.call('other', method, url, body)).status, 404, `${method} ${url}`);
    }
    assert.equal((await app.call('other', 'GET', '/api/quizzes')).body.quizzes.length, 0);
    assert.equal((await app.call('anon', 'GET', '/api/quizzes')).status, 401);
    assert.equal((await app.call('anon', 'POST', '/api/quizzes', { topic: 'x' })).status, 401);
    assert.equal((await app.call('stu', 'DELETE', `/api/quizzes/${quizId}`)).status, 200);
  } finally {
    await app.close();
  }
});

test('quiz requests are checked: course access, sizes, kinds, and a model that writes nothing usable', async () => {
  const fixture = gateway({ quiz: 'Sorry, I cannot do that.' });
  const app = await readyApp(fixture);
  try {
    assert.equal((await app.call('stu', 'POST', '/api/quizzes', { course_id: 1 })).status, 403, 'not enrolled');
    assert.equal((await app.call('stu', 'POST', '/api/quizzes', {})).status, 400, 'nothing to quiz about');
    assert.equal((await app.call('stu', 'POST', '/api/quizzes', { topic: 'x', count: 50 })).status, 400);
    assert.equal((await app.call('stu', 'POST', '/api/quizzes', { topic: 'x', types: ['essay'] })).status, 400);
    assert.equal((await app.call('stu', 'POST', '/api/quizzes', { topic: 'x', difficulty: 'impossible' })).status, 400);
    const empty = await app.call('stu', 'POST', '/api/quizzes', { topic: 'Photosynthesis' });
    assert.equal(empty.status, 503);
    assert.match(empty.body.error, /could not write usable questions/);
    await app.call('stu', 'POST', '/api/courses/1/enroll');
    fixture.state.calls.length = 0;
    const course = await app.call('stu', 'POST', '/api/quizzes', { course_id: 1, notes: 'Light reactions happen in the thylakoids.' });
    assert.equal(course.status, 503, 'still nothing usable, but access passed');
    assert.match(fixture.state.calls[0].messages.at(-1).content, /<NOTES>/);
    assert.match(fixture.state.calls[0].messages.at(-1).content, /DEMO101/);
  } finally {
    await app.close();
  }
});

test('“quiz me” in the chat opens the quiz tool with checked settings', async () => {
  const app = await readyApp(gateway());
  try {
    const r = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'Quiz me on photosynthesis' });
    const action = r.body.message.actions[0];
    assert.equal(action.name, 'quiz.start');
    assert.equal(action.ok, true);
    assert.equal(action.client.type, 'navigate');
    const url = new URL(action.client.path, 'http://x');
    assert.equal(url.pathname, '/quiz/new');
    assert.equal(url.searchParams.get('topic'), 'photosynthesis');
    assert.equal(url.searchParams.get('count'), '5');
    assert.equal(url.searchParams.get('types'), 'single,numeric', 'unknown kinds are left out');
  } finally {
    await app.close();
  }
});
