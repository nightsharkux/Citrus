'use strict';
/**
 * The course page as an outline (like Moodle): topics inside topics, files and links in each, lectures in topics,
 * and Citrus reading a topic's files during its lectures. Who may change and who may download.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

async function setup() {
  const state = { calls: [] };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    state.calls.push(body);
    return Response.json({ choices: [{ message: { content: 'Start from Av = λv.' } }] });
  };
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl });
  await app.login('admin');
  const lecturerId = await app.lecturer('prof');
  await app.lecturer('other');
  const course = await app.call('admin', 'POST', '/api/courses', { title: 'Linear Algebra', code: 'MA2' });
  await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
  await app.register('ann');
  await app.call('ann', 'POST', `/api/courses/${course.body.id}/enroll`);
  await app.register('newbie');
  return { app, state, courseId: course.body.id };
}

const upload = (app, who, courseId, name, body, { section, type = 'text/plain' } = {}) => app.call(who, 'POST', `/api/courses/${courseId}/files`, Buffer.from(body), {
  headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name), ...(section ? { 'x-section-id': String(section) } : {}) },
});

test('topics inside topics with files and links; students download, only the lecturer changes it', async () => {
  const { app, courseId } = await setup();
  try {
    const algebra = await app.call('prof', 'POST', `/api/courses/${courseId}/sections`, { title: 'Week 1 · Matrices', summary: 'Start here' });
    assert.equal(algebra.status, 201);
    const eigen = await app.call('prof', 'POST', `/api/courses/${courseId}/sections`, { title: 'Eigenvalues', parent_id: algebra.body.id });
    const week2 = await app.call('prof', 'POST', `/api/courses/${courseId}/sections`, { title: 'Week 2' });
    assert.equal((await app.call('ann', 'POST', `/api/courses/${courseId}/sections`, { title: 'Mine' })).status, 403);
    assert.equal((await app.call('other', 'POST', `/api/courses/${courseId}/sections`, { title: 'Theirs' })).status, 403);

    const file = await upload(app, 'prof', courseId, 'Eigenvalues – notes.txt', 'An eigenvector keeps its direction: Av = λv.', { section: eigen.body.id });
    assert.equal(file.status, 201);
    assert.equal(file.body.readable, true);
    const page = await upload(app, 'prof', courseId, 'page.html', '<script>alert(1)</script>', { type: 'text/html' });
    const link = await app.call('prof', 'POST', `/api/courses/${courseId}/links`, { title: 'Moodle', url: 'moodle.example.edu/course/7', section_id: algebra.body.id });
    assert.equal(link.status, 201);
    assert.equal((await app.call('prof', 'POST', `/api/courses/${courseId}/links`, { url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await upload(app, 'prof', courseId, 'x.txt', 'hello', { section: 99999 })).status, 400, 'a topic of this course');

    const outline = await app.call('ann', 'GET', `/api/courses/${courseId}/outline`);
    assert.equal(outline.status, 200);
    assert.deepEqual(outline.body.sections.map((s) => [s.title, s.parent_id]), [['Week 1 · Matrices', null], ['Eigenvalues', algebra.body.id], ['Week 2', null]]);
    assert.equal(outline.body.items.find((i) => i.kind === 'link').url, 'https://moodle.example.edu/course/7');
    assert.ok(!('data' in outline.body.items[0]) && !('text' in outline.body.items[0]), 'the outline does not carry the files');
    assert.equal(outline.body.isTeacher, false);
    assert.equal((await app.call('newbie', 'GET', `/api/courses/${courseId}/outline`)).status, 403);

    const got = await app.call('ann', 'GET', `/api/course-items/${file.body.id}/file`, undefined, { raw: true });
    assert.equal(got.status, 200);
    assert.match(got.headers.get('content-disposition'), /^attachment; filename="Eigenvalues _ notes.txt"; filename\*=UTF-8''Eigenvalues%20%E2%80%93%20notes\.txt/);
    assert.equal(await got.text(), 'An eigenvector keeps its direction: Av = λv.');
    assert.equal((await app.call('newbie', 'GET', `/api/course-items/${file.body.id}/file`)).status, 403);
    const html = await app.call('ann', 'GET', `/api/course-items/${page.body.id}/file?view=1`, undefined, { raw: true });
    assert.equal(html.headers.get('content-type'), 'application/octet-stream', 'an uploaded page never runs in the app');
    assert.match(html.headers.get('content-disposition'), /^attachment/);

    // Reordering and moving.
    await app.call('prof', 'PATCH', `/api/sections/${week2.body.id}`, { move: 'up' });
    const order = (await app.call('prof', 'GET', `/api/courses/${courseId}/outline`)).body.sections.filter((s) => !s.parent_id).map((s) => s.title);
    assert.deepEqual(order, ['Week 2', 'Week 1 · Matrices']);
    assert.equal((await app.call('prof', 'PATCH', `/api/sections/${algebra.body.id}`, { parent_id: eigen.body.id })).status, 400, 'not inside itself');
    assert.equal((await app.call('prof', 'PATCH', `/api/course-items/${file.body.id}`, { section_id: week2.body.id })).status, 200);
    assert.equal((await app.call('ann', 'DELETE', `/api/course-items/${file.body.id}`)).status, 403);
  } finally {
    await app.close();
  }
});

test('a lecture in a topic: Citrus reads the topic files; deleting the topic keeps the lecture', async () => {
  const { app, state, courseId } = await setup();
  try {
    const topic = await app.call('prof', 'POST', `/api/courses/${courseId}/sections`, { title: 'Eigenvalues' });
    const sub = await app.call('prof', 'POST', `/api/courses/${courseId}/sections`, { title: 'Worked examples', parent_id: topic.body.id });
    await upload(app, 'prof', courseId, 'definitions.txt', 'Definition: the characteristic polynomial is det(A - λI).', { section: topic.body.id });
    await upload(app, 'prof', courseId, 'example.txt', 'Example: A = [[2,0],[0,3]] has eigenvalues 2 and 3.', { section: sub.body.id });

    const lecture = await app.call('prof', 'POST', `/api/courses/${courseId}/lectures`, { topic: 'Eigenvalues, part 1', section_id: sub.body.id });
    assert.equal(lecture.status, 201);
    assert.equal((await app.call('prof', 'POST', `/api/courses/${courseId}/lectures`, { topic: 'Somewhere else', section_id: 424242 })).status, 400);
    const started = await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, lecture_id: lecture.body.id });
    await app.call('prof', 'POST', `/api/live/sessions/${started.body.session.id}/ask`, { question: 'What is the definition I use?' });
    const asked = JSON.stringify(state.calls.at(-1).messages.at(-1).content);
    assert.match(asked, /TOPIC_FILE[^>]*Worked examples[\s\S]*eigenvalues 2 and 3/, 'the files of the lecture\'s own topic');
    assert.match(asked, /characteristic polynomial is det/, 'and of the topic around it');
    await app.call('prof', 'POST', `/api/live/sessions/${started.body.session.id}/end`);

    // "Go live" straight inside a topic makes the lecture there.
    const quick = await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Quick one', section_id: topic.body.id });
    assert.equal(app.db.get('SELECT section_id FROM lectures WHERE id = ?', quick.body.session.lecture_id).section_id, topic.body.id);
    await app.call('prof', 'POST', `/api/live/sessions/${quick.body.session.id}/end`);

    const outline = (await app.call('ann', 'GET', `/api/courses/${courseId}/outline`)).body;
    assert.equal(outline.lectures.find((l) => l.id === lecture.body.id).section_id, sub.body.id);
    assert.ok(outline.lectures.find((l) => l.id === lecture.body.id).lastSession, 'with its review');

    const removed = await app.call('prof', 'DELETE', `/api/sections/${topic.body.id}`);
    assert.equal(removed.body.removed, 2);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM course_items WHERE course_id = ?', courseId).n, 0);
    assert.equal(app.db.get('SELECT section_id FROM lectures WHERE id = ?', lecture.body.id).section_id, null, 'the lecture moves to General');
  } finally {
    await app.close();
  }
});
