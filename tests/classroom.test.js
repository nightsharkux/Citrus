'use strict';
/**
 * The classroom loop, end to end: a join code on the projector, flags on moments, a kept transcript that Campus can
 * answer from during and after the lecture, and who may see what.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

function gateway() {
  const state = { calls: [] };
  return {
    state,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      state.calls.push(body);
      const turn = JSON.stringify(body.messages.at(-1).content);
      const reply = /student flagged minute/i.test(body.messages[0].content) ? 'At that moment the lecturer was deriving the gradient. Try: what sign does the update take?' : /MY_FLAGS/.test(turn) ? 'The lecturer said we subtract the gradient because it points uphill (minute 1).' : 'Students are stuck on the sign of the update.';
      return Response.json({ choices: [{ message: { content: reply } }] });
    },
  };
}

async function setup(fixture) {
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: fixture.fetchImpl });
  await app.login('admin');
  const lecturerId = await app.lecturer('prof');
  await app.lecturer('other');
  const course = await app.call('admin', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' });
  await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
  for (const who of ['ann', 'ben']) {
    await app.register(who);
    await app.call(who, 'POST', `/api/courses/${course.body.id}/enroll`);
  }
  await app.register('newbie');
  return { app, courseId: course.body.id };
}

test('students join with the code on the screen, which also joins the course', async () => {
  const fixture = gateway();
  const { app, courseId } = await setup(fixture);
  try {
    const started = await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Week 5' });
    assert.equal(started.status, 201);
    const code = started.body.session.joinCode;
    assert.match(code, /^\d{6}$/);
    assert.equal(started.body.session.keepTranscript, true, 'Campus keeps the transcript unless the lecturer says no');
    assert.equal(started.body.present, 0);

    // Not enrolled yet: the code is enough.
    assert.equal((await app.call('newbie', 'GET', `/api/live/courses/${courseId}/active`)).status, 403);
    assert.equal((await app.call('newbie', 'POST', '/api/live/join', { code: '12345' })).status, 400, 'six digits');
    const wrong = code === '000000' ? '000001' : '000000';
    assert.equal((await app.call('newbie', 'POST', '/api/live/join', { code: wrong })).status, 404);
    const joined = await app.call('newbie', 'POST', '/api/live/join', { code: `${code.slice(0, 3)} ${code.slice(3)}` });
    assert.equal(joined.status, 200, 'spaces from the projector are fine');
    assert.equal(joined.body.course_id, courseId);
    const active = await app.call('newbie', 'GET', `/api/live/courses/${courseId}/active`);
    assert.equal(active.body.session.id, started.body.session.id);
    assert.equal(active.body.session.joinCode, undefined, 'students do not need the code back');

    // Another lecturer cannot use a code to look into someone else's lecture.
    assert.equal((await app.call('other', 'POST', '/api/live/join', { code })).status, 403);
    assert.equal((await app.call('anon', 'POST', '/api/live/join', { code })).status, 401);

    const view = await app.call('prof', 'GET', `/api/live/sessions/${started.body.session.id}`);
    assert.equal(view.body.present, 1, 'the lecturer sees how many are in the room');

    // After the lecture the code no longer works.
    await app.call('prof', 'POST', `/api/live/sessions/${started.body.session.id}/end`);
    assert.equal((await app.call('ann', 'POST', '/api/live/join', { code })).status, 404);
  } finally {
    await app.close();
  }
});

test('flags reach the lecturer without names, and each student only sees their own', async () => {
  const fixture = gateway();
  const { app, courseId } = await setup(fixture);
  try {
    const sid = (await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Week 5' })).body.session.id;
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'nope' })).status, 400);
    const flag = await app.call('ann', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'example', note: 'the second formula' });
    assert.equal(flag.status, 201);
    assert.equal(flag.body.minute, 1);
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'fast' })).status, 409, 'not twice within seconds');
    await app.call('ben', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'fast' });
    assert.equal((await app.call('newbie', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'fast' })).status, 403, 'not in the course');
    assert.equal((await app.call('prof', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'fast' })).status, 403, 'the lecturer does not flag');

    const view = await app.call('prof', 'GET', `/api/live/sessions/${sid}`);
    assert.deepEqual(view.body.flagCounts, { confused: 0, fast: 1, example: 1, question: 0 });
    assert.equal(view.body.flags.find((f) => f.kind === 'example').note, 'the second formula');
    assert.ok(!JSON.stringify(view.body.flags).match(/user|ann|ben/i), 'no names or ids of students');

    const bens = await app.call('ben', 'GET', `/api/live/sessions/${sid}`);
    assert.deepEqual(bens.body.flags.map((f) => f.kind), ['fast'], 'only their own flags');
    assert.ok(!JSON.stringify(bens.body).includes('second formula'));

    // Campus explains a flag to the student who made it, and only to them.
    assert.equal((await app.call('ben', 'POST', `/api/live/sessions/${sid}/flags/${flag.body.id}/explain`)).status, 404);
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/transcript`, { text: 'Now we derive the gradient of the loss with respect to the weights.' });
    const explained = await app.call('ann', 'POST', `/api/live/sessions/${sid}/flags/${flag.body.id}/explain`);
    assert.equal(explained.status, 200);
    assert.match(explained.body.explanation, /deriving the gradient/);
    assert.match(JSON.stringify(fixture.state.calls.at(-1).messages.at(-1).content), /derive the gradient of the loss/, 'what was said around the flag reaches the model');
    const recap = await app.call('ann', 'GET', `/api/live/sessions/${sid}/recap`);
    assert.match(recap.body.flags[0].explanation, /deriving the gradient/, 'the explanation is kept for the recap');

    // The lecturer asks what students are stuck on: the flags are in the model's context.
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/ask`, { question: 'What are they stuck on?' });
    assert.match(fixture.state.calls.at(-1).messages[0].content, /<FLAGS>[\s\S]*needs an example[\s\S]*the second formula/);
  } finally {
    await app.close();
  }
});

test('a kept transcript lets students ask Campus about the lecture during and after it', async () => {
  const fixture = gateway();
  const { app, courseId } = await setup(fixture);
  try {
    const sid = (await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Week 5' })).body.session.id;
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/transcript`, { text: 'The gradient points uphill, so we subtract it from the weights.' });
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/transcript`, { text: 'hi' })).status, 403);

    const during = await app.call('ann', 'POST', `/api/live/sessions/${sid}/student-ask`, { question: 'Why do we subtract?' });
    assert.equal(during.status, 200);
    assert.equal(during.body.heard, true);
    assert.match(JSON.stringify(fixture.state.calls.at(-1).messages.at(-1).content), /<TRANSCRIPT>[\s\S]*points uphill/);
    assert.equal((await app.call('newbie', 'POST', `/api/live/sessions/${sid}/student-ask`, { question: 'Why?' })).status, 403);

    // The lecturer downloads it as a file any AI can read; students cannot.
    const file = await app.call('prof', 'GET', `/api/live/sessions/${sid}/transcript.txt`, undefined, { raw: true });
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-type'), /text\/plain/);
    const body = await file.text();
    assert.match(body, /INSTRUCTIONS FOR ANY AI/);
    assert.match(body, /\[00:00:\d\d · P1\] The gradient points uphill/, 'each line is tied to its second and part');
    assert.equal((await app.call('ann', 'GET', `/api/live/sessions/${sid}/transcript.txt`)).status, 403);

    // After the end the memory is gone but the kept transcript still answers.
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/end`);
    const after = await app.call('ann', 'POST', `/api/live/sessions/${sid}/student-ask`, { question: 'What was the rule again?' });
    assert.equal(after.body.heard, true);
    assert.match(JSON.stringify(fixture.state.calls.at(-1).messages.at(-1).content), /\[minute 1\] The gradient points uphill/);
    assert.equal((await app.call('ann', 'GET', `/api/live/sessions/${sid}/recap`)).body.canAsk, true);

    // Deleting it: Campus can no longer answer from it.
    assert.equal((await app.call('ann', 'DELETE', `/api/live/sessions/${sid}/transcript`)).status, 403);
    await app.call('prof', 'DELETE', `/api/live/sessions/${sid}/transcript`);
    assert.equal((await app.call('ann', 'GET', `/api/live/sessions/${sid}/recap`)).body.canAsk, false);
    assert.equal((await app.call('prof', 'GET', `/api/live/sessions/${sid}/transcript.txt`)).status, 404);
  } finally {
    await app.close();
  }
});

test('without "keep the transcript" nothing the lecturer says is stored', async () => {
  const fixture = gateway();
  const { app, courseId } = await setup(fixture);
  try {
    const started = await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Week 6', keep_transcript: false });
    const sid = started.body.session.id;
    assert.equal(started.body.session.keepTranscript, false);
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/transcript`, { text: 'Private remark about the exam.' });
    assert.equal(app.db.get('SELECT COUNT(*) n FROM live_transcript WHERE session_id = ?', sid).n, 0);
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/end`);
    assert.equal((await app.call('prof', 'GET', `/api/live/sessions/${sid}/transcript.txt`)).status, 404);
    assert.equal((await app.call('ann', 'GET', `/api/live/sessions/${sid}/recap`)).body.canAsk, false);
  } finally {
    await app.close();
  }
});

test('a lecture that was ended and reopened can be rejoined, with the same code and notes', async () => {
  const fixture = gateway();
  const { app, courseId } = await setup(fixture);
  try {
    const note = await app.call('prof', 'POST', '/api/assistant/attachments', { name: 'week5.txt', mime: 'text/plain', data: Buffer.from('Gradient descent notes for week five.').toString('base64') });
    const first = await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Week 5', notes: [note.body.attachment.id] });
    const lectureId = app.db.get('SELECT lecture_id FROM live_sessions WHERE id = ?', first.body.session.id).lecture_id;
    await app.call('ann', 'POST', `/api/live/sessions/${first.body.session.id}/signal`, { level: 1 });
    await app.call('prof', 'POST', `/api/live/sessions/${first.body.session.id}/end`);
    assert.equal((await app.call('ann', 'GET', `/api/live/courses/${courseId}/active`)).body.session, null);

    // The lecturer reopens it from the course page.
    const course = await app.call('prof', 'GET', `/api/courses/${courseId}`);
    const lecture = course.body.lectures.find((l) => l.id === lectureId);
    assert.equal(lecture.live, false);
    assert.equal(lecture.lastSession, first.body.session.id);
    const again = await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, lecture_id: lectureId });
    assert.equal(again.status, 201);
    assert.notEqual(again.body.session.id, first.body.session.id);
    assert.equal(again.body.session.joinCode, first.body.session.joinCode, 'the code on the screen still works');
    assert.deepEqual(again.body.notes.map((n) => n.name), ['week5.txt'], 'the notes come back too');

    // Students get back in: by the course, by the code and in the list of lectures.
    const active = await app.call('ann', 'GET', `/api/live/courses/${courseId}/active`);
    assert.equal(active.body.session.id, again.body.session.id);
    assert.equal(active.body.session.lecture_id, lectureId);
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${again.body.session.id}/signal`, { level: 2 })).status, 200, 'and can answer again');
    assert.equal((await app.call('ben', 'POST', '/api/live/join', { code: first.body.session.joinCode })).body.session, again.body.session.id);
    const feed = await app.call('ann', 'GET', '/api/lectures/feed?scope=mine');
    assert.equal(feed.body.lectures.find((l) => l.id === lectureId).state, 'live');

    // Ending it from the course page ends the live session as well.
    await app.call('prof', 'PATCH', `/api/lectures/${lectureId}`, { status: 'ended' });
    assert.equal((await app.call('ann', 'GET', `/api/live/courses/${courseId}/active`)).body.session, null);
  } finally {
    await app.close();
  }
});

test('the class status reaches the Campus Puck in the lecture room, as counts only', async () => {
  const fixture = gateway();
  const { app, courseId } = await setup(fixture);
  try {
    await app.call('admin', 'POST', '/api/devices', { name: 'Desk puck', kind: 'puck', room: 'HSG 001' });
    await app.call('admin', 'POST', '/api/devices', { name: 'Other room', kind: 'puck', room: 'WTC 2' });
    await app.register('cem');
    await app.call('cem', 'POST', `/api/courses/${courseId}/enroll`);
    const sid = (await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Week 5', room: 'HSG 001' })).body.session.id;
    for (const who of ['ann', 'ben', 'cem']) await app.call(who, 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 });
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/end`);
    const sent = app.db.all("SELECT d.room, c.payload FROM device_commands c JOIN devices d ON d.id = c.device_id WHERE c.type = 'class.pulse' ORDER BY c.id");
    assert.ok(sent.every((c) => c.room === 'HSG 001'), 'only the lecture room');
    const statuses = sent.map((c) => JSON.parse(c.payload).status);
    assert.deepEqual([statuses[0], statuses.includes('trouble'), statuses.at(-1)], ['quiet', true, 'off']);
    assert.ok(!sent.some((c) => /ann|ben|cem|user/i.test(c.payload)), 'no names');
  } finally {
    await app.close();
  }
});

test('lecture notes open full screen for the lecturer: PDFs as PDFs, other files as text', async () => {
  const fixture = gateway();
  const { app, courseId } = await setup(fixture);
  try {
    const words = 'Gradient descent moves the weights against the slope of the loss function step by step';
    const pdf = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n4 0 obj << /Length 120 >>\nstream\nBT /F1 12 Tf 72 720 Td (${words}) Tj ET\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
    const upPdf = await app.call('prof', 'POST', '/api/assistant/attachments', { name: 'week5.pdf', mime: 'application/pdf', data: pdf.toString('base64'), keep_file: true });
    assert.equal(upPdf.status, 200);
    const upText = await app.call('prof', 'POST', '/api/assistant/attachments', { name: 'outline.md', mime: 'text/markdown', data: Buffer.from('# Week 5\n\nGradient descent, step size, convergence.').toString('base64') });
    const started = await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Week 5', notes: [upPdf.body.attachment.id, upText.body.attachment.id] });
    const sid = started.body.session.id;
    const [pdfNote, textNote] = started.body.notes;

    const one = await app.call('prof', 'GET', `/api/live/sessions/${sid}/notes/${pdfNote.id}`);
    assert.equal(one.body.viewable, 'pdf');
    const file = await app.call('prof', 'GET', `/api/live/sessions/${sid}/notes/${pdfNote.id}/file`, undefined, { raw: true });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.equal(file.headers.get('x-frame-options'), 'SAMEORIGIN', 'the app itself may show it in a frame');
    assert.match(file.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.equal((await file.arrayBuffer()).byteLength, pdf.length);

    const other = await app.call('prof', 'GET', `/api/live/sessions/${sid}/notes/${textNote.id}`);
    assert.equal(other.body.viewable, 'text');
    assert.match(other.body.text, /Gradient descent, step size/);
    assert.equal((await app.call('prof', 'GET', `/api/live/sessions/${sid}/notes/${textNote.id}/file`)).status, 404);

    assert.equal((await app.call('ann', 'GET', `/api/live/sessions/${sid}/notes/${pdfNote.id}/file`)).status, 403, 'students cannot open the notes');
    assert.equal((await app.call('prof', 'GET', `/api/live/sessions/${sid}/notes/999999`)).status, 404);
  } finally {
    await app.close();
  }
});
