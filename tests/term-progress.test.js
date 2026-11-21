'use strict';
/**
 * The course over the term: the lecturer's overview (lectures, trend, topics, hardest parts, students who shared
 * their name), a student's own progress (their results and every part they found hard), both as .txt for any AI;
 * and Ask Citrus answering from the course's files and the term at any time, with the files cited.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { buildTerm, trendOf } = require('../src/modules/live/term');

function gateway() {
  const state = { calls: [] };
  return {
    state,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      state.calls.push(body);
      return Response.json({ choices: [{ message: { content: 'Start with the characteristic polynomial [1].' } }] });
    },
  };
}

async function setup() {
  const fixture = gateway();
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: fixture.fetchImpl });
  await app.login('admin');
  const lecturerId = await app.lecturer('prof');
  await app.lecturer('other');
  const course = await app.call('admin', 'POST', '/api/courses', { title: 'Linear Algebra', code: 'MA2' });
  await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
  const ids = {};
  for (const who of ['ann', 'ben', 'cat', 'dan']) {
    ids[who] = (await app.register(who)).body.user.id;
    await app.call(who, 'POST', `/api/courses/${course.body.id}/enroll`);
  }
  await app.register('newbie');
  return { app, fixture, courseId: course.body.id, ids };
}

/** A finished lecture `daysAgo` with known answers: `ann` and `ben` levels for the first and the second part. */
async function lecture(app, courseId, { title, sectionId = null, daysAgo, ann, ben, annShares = false, flag = null, ids }) {
  const lectureId = (await app.call('prof', 'POST', `/api/courses/${courseId}/lectures`, { topic: title, ...(sectionId ? { section_id: sectionId } : {}) })).body.id;
  const sid = (await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, lecture_id: lectureId })).body.session.id;
  const started = Date.now() - daysAgo * 86_400_000;
  const t = (sec) => new Date(started + sec * 1000).toISOString();
  app.db.run('UPDATE live_sessions SET started = ?, ended = ? WHERE id = ?', t(0), t(600), sid);
  app.db.run("INSERT INTO live_moments(session_id, kind, minute, note, created) VALUES(?, 'point', 5, ?, ?)", sid, `${title}: the basics`, t(300));
  // Cat and Dan answer like Ben, so every minute has enough answers to count (and they stay anonymous).
  for (const [who, levels] of [['ann', ann], ['ben', ben], ['cat', ben], ['dan', ben]]) {
    app.db.run('INSERT INTO live_attendees(session_id, user_id, joined, share_name) VALUES(?, ?, ?, ?)', sid, ids[who], t(5), who === 'ann' && annShares ? 1 : 0);
    app.db.run('INSERT INTO live_signals(session_id, user_id, level, created) VALUES(?, ?, ?, ?)', sid, ids[who], levels[0], t(100));
    app.db.run('INSERT INTO live_signals(session_id, user_id, level, created) VALUES(?, ?, ?, ?)', sid, ids[who], levels[1], t(400));
  }
  if (flag) app.db.run("INSERT INTO live_flags(session_id, user_id, kind, minute, note, created) VALUES(?, ?, 'confused', 7, ?, ?)", sid, ids.ann, flag, t(410));
  return sid;
}

test('the lecturer sees the term; a student sees only their own progress; both download it for any AI', async () => {
  const { app, courseId, ids } = await setup();
  try {
    const week1 = (await app.call('prof', 'POST', `/api/courses/${courseId}/sections`, { title: 'Week 1 · Matrices' })).body.id;
    const eigen = (await app.call('prof', 'POST', `/api/courses/${courseId}/sections`, { title: 'Eigenvalues', parent_id: week1 })).body.id;
    const s1 = await lecture(app, courseId, { title: 'Matrices', sectionId: week1, daysAgo: 14, ann: [1, 1], ben: [1, 1], ids });
    const s2 = await lecture(app, courseId, { title: 'Eigenvalues', sectionId: eigen, daysAgo: 7, ann: [1, 3], ben: [1, 2], annShares: true, flag: 'what is lambda?', ids });
    const s3 = await lecture(app, courseId, { title: 'Revision', daysAgo: 1, ann: [1, 1], ben: [2, 1], ids });
    // A lecture still running is not part of the term yet.
    await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Live now' });

    const term = await app.call('prof', 'GET', `/api/courses/${courseId}/progress`);
    assert.equal(term.status, 200);
    assert.equal(term.body.view, 'term');
    assert.deepEqual(term.body.lectures.map((l) => [l.session, l.title]), [[s1, 'Matrices'], [s2, 'Eigenvalues'], [s3, 'Revision']], 'oldest first, finished only');
    assert.equal(term.body.averages.lectures, 3);
    assert.equal(term.body.lectures[1].topic.path, 'Week 1 · Matrices › Eigenvalues');
    const week = term.body.topics.find((t) => t.title === 'Week 1 · Matrices');
    assert.equal(week.lectures, 2, 'a topic counts the lectures of the topics inside it');
    assert.deepEqual(week.sessions, [s1, s2]);
    const order = term.body.topics.map((t) => t.understood);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'weakest first');
    assert.deepEqual(term.body.topics.map((t) => t.title).sort(), ['General', 'Week 1 · Matrices']);
    const hard = term.body.hardest[0];
    assert.equal(hard.session, s2);
    assert.equal(hard.part, 'P2');
    assert.equal(hard.status, 'trouble');
    assert.deepEqual(term.body.students.map((s) => [s.name, s.lectures, s.parts.map((p) => p.part)]), [['Ann Person', 1, ['P2']]], 'only Ann shared her name, and only in that lecture');
    assert.equal(term.body.trend, null, 'a trend needs four lectures');

    const txt = await (await app.call('prof', 'GET', `/api/courses/${courseId}/progress.txt`, undefined, { raw: true })).text();
    assert.match(txt, /^CITRUS \| TERM OVERVIEW/);
    assert.ok(txt.indexOf('INSTRUCTIONS FOR ANY AI') < txt.indexOf('=== DATA ==='));
    assert.match(txt, new RegExp(`\\[LECTURE date=\\d{4}-\\d\\d-\\d\\d session=${s2}\\] "Eigenvalues" understood=\\d+% status=\\w+`));
    assert.match(txt, new RegExp(`\\[HARD_PART date=\\S+ session=${s2} P2 t=\\S+\\] "[^"]+" lecture="Eigenvalues" understood=\\d+% status=trouble .*#follow-up`));
    assert.match(txt, /\[STUDENT "Ann Person"\] .*needs_help_with=\S+:P2 #follow-up/);
    assert.doesNotMatch(txt, /Ben Person/, 'Ben never shared his name');

    // Ann: her own progress only.
    const mine = await app.call('ann', 'GET', `/api/courses/${courseId}/progress`);
    assert.equal(mine.body.view, 'mine');
    assert.equal(mine.body.averages.lectures, 3);
    assert.deepEqual(mine.body.parts.map((p) => [p.session, p.part, p.you]), [[s2, 'P2', 'lost']], 'the part she found hard');
    assert.deepEqual(mine.body.parts[0].flags.map((f) => f.note), ['what is lambda?']);
    assert.ok(!('students' in mine.body) && !('hardest' in mine.body), 'nothing about other students');
    // A student is never told how the class did: not in the page's data, not in the file for AI.
    assert.ok(!('class' in mine.body.averages), 'no class average');
    assert.ok(mine.body.lectures.every((l) => !('class' in l)) && mine.body.parts.every((p) => !('class' in p)), 'no class figures per lecture or part');
    assert.doesNotMatch(JSON.stringify(mine.body), /"class"/);
    const annTxt = await (await app.call('ann', 'GET', `/api/courses/${courseId}/progress.txt`, undefined, { raw: true })).text();
    assert.match(annTxt, /^CITRUS \| MY PROGRESS/);
    assert.match(annTxt, new RegExp(`\\[TARGET date=\\S+ session=${s2} P2 t=\\S+\\] .* you=lost .*#target`));
    assert.match(annTxt, /\[FLAG t=\S+\] kind=confused note="what is lambda\?"/);
    assert.doesNotMatch(annTxt, /scope=class|class=\d|class=n\/a/, 'no class figures in the file');
    const ben = await app.call('ben', 'GET', `/api/courses/${courseId}/progress`);
    assert.ok(ben.body.parts.every((p) => !p.flags.some((f) => f.note === 'what is lambda?')), 'not Ann\'s flag');

    assert.equal((await app.call('newbie', 'GET', `/api/courses/${courseId}/progress`)).status, 403);
    assert.equal((await app.call('other', 'GET', `/api/courses/${courseId}/progress`)).status, 403, 'not another lecturer');
  } finally {
    await app.close();
  }
});

test('Ask Citrus answers from the course files at any time, cites them, and knows the term', async () => {
  const { app, fixture, courseId, ids } = await setup();
  try {
    const topic = (await app.call('prof', 'POST', `/api/courses/${courseId}/sections`, { title: 'Eigenvalues' })).body.id;
    const file = await app.call('prof', 'POST', `/api/courses/${courseId}/files`, Buffer.from('Characteristic polynomial: the eigenvalues are the roots of det(A - λI) = 0.'), {
      headers: { 'content-type': 'text/plain', 'x-file-name': 'eigen-notes.txt', 'x-section-id': String(topic) },
    });
    await lecture(app, courseId, { title: 'Spectral theory', sectionId: topic, daysAgo: 2, ann: [1, 3], ben: [1, 3], ids });

    // A student asks without any button: the matching file is read and offered as a source.
    const asked = await app.call('ann', 'POST', '/api/assistant/messages', { prompt: 'How do I get the eigenvalues from the characteristic polynomial?' });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const system = fixture.state.calls.at(-1).messages[0].content;
    assert.match(system, /roots of det\(A - λI\)/, 'the file text reaches Citrus');
    const source = asked.body.message.sources.find((s) => s.id === `course-file-${file.body.id}`);
    assert.ok(source, 'cited as a source');
    assert.equal(source.url, `/api/course-items/${file.body.id}/file?view=1`);
    assert.doesNotMatch(system, /COURSE OVERVIEW/, 'no course named: files only');

    // Someone outside the course never gets its files.
    await app.call('newbie', 'POST', '/api/assistant/messages', { prompt: 'How do I get the eigenvalues from the characteristic polynomial?' });
    assert.doesNotMatch(fixture.state.calls.at(-1).messages[0].content, /roots of det/);

    // "Ask Citrus about the term" from the course page: the lecturer's overview and the files.
    await app.call('prof', 'POST', '/api/assistant/messages', { prompt: 'Which parts should I revisit?', course_id: courseId });
    const lect = fixture.state.calls.at(-1).messages[0].content;
    assert.match(lect, /COURSE OVERVIEW: the user is talking about MA2 Linear Algebra/);
    assert.match(lect, /CITRUS \| TERM OVERVIEW/);
    assert.match(lect, /roots of det/, 'all of the course files when asked about the course');
    // A student naming the course by its code gets their own progress, never the term overview.
    await app.call('ben', 'POST', '/api/assistant/messages', { prompt: 'How am I doing in MA2?' });
    const benSystem = fixture.state.calls.at(-1).messages[0].content;
    assert.match(benSystem, /CITRUS \| MY PROGRESS/);
    assert.doesNotMatch(benSystem, /TERM OVERVIEW|Ann Person/);
    // A course id that is not theirs is ignored.
    await app.call('newbie', 'POST', '/api/assistant/messages', { prompt: 'Tell me about it', course_id: courseId });
    assert.doesNotMatch(fixture.state.calls.at(-1).messages[0].content, /COURSE OVERVIEW/);

    // A course quiz draws on the course files too.
    await app.call('ann', 'POST', '/api/quizzes', { course_id: courseId, topic: 'characteristic polynomial eigenvalues', count: 3 });
    assert.ok(fixture.state.calls.some((c) => c.messages.some((m) => typeof m.content === 'string' && /course file, topic: Eigenvalues/.test(m.content) && /roots of det/.test(m.content))));
  } finally {
    await app.close();
  }
});

test('the trend compares the last three lectures with the three before', () => {
  assert.equal(trendOf([80, 90, 70]), null);
  assert.deepEqual(trendOf([90, 90, 90, 70, 70, 70]), { direction: 'falling', change: -20, recent: 70, before: 90 });
  assert.equal(trendOf([70, 72, 70, 71, 73]).direction, 'steady');
  const empty = buildTerm({ course: { id: 1, code: 'X', title: 'Y' } });
  assert.deepEqual(empty.averages, { term: null, status: 'quiet', lectures: 0, flags: 0, struggles: 0, answeredBy: 0 });
});
