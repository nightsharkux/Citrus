'use strict';
/**
 * The lecture record: every result tagged with its second and section, instructions any AI can follow, notes Citrus
 * writes from it, the lecturer's review conversation, and a student's own results. Who sees what.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { buildRecord, recordText } = require('../src/modules/live/record');

const START = Date.parse('2026-11-14T09:00:00Z');
const at = (sec) => new Date(START + sec * 1000).toISOString();

function lecture() {
  const signals = [];
  for (let u = 1; u <= 6; u += 1) signals.push({ user_id: u, level: 1, created: at(60 + u * 5) });
  for (let u = 1; u <= 4; u += 1) signals.push({ user_id: u, level: 3, created: at(400 + u * 7) });
  return {
    session: { id: 1, title: 'Eigenvalues', started: at(0), ended: at(900) },
    course: { code: 'MA2', title: 'Linear Algebra' },
    enrolled: 30,
    transcript: [{ text: 'Today: eigenvalues.', created: at(20) }, { text: 'The characteristic polynomial is det(A - λI).', created: at(410) }],
    signals,
    flags: [{ user_id: 2, kind: 'confused', minute: 7, note: 'what is lambda?', created: at(415) }, { user_id: 3, kind: 'example', minute: 8, note: 'secret note of user 3', created: at(470) }],
    struggles: [{ lost: 4, unsure: 0, answered: 6, note: 'The step to det(A - λI) = 0.', created: at(440) }],
    points: [{ text: 'An eigenvector keeps its direction.', created: at(300) }, { text: 'Eigenvalues are roots of det(A - λI).', created: at(600) }],
    notes: [{ name: 'slides.pdf', text: 'Slide 1: eigenvalues' }],
  };
}

test('the record ties every result to its second and section, and averages are tagged', () => {
  const r = buildRecord(lecture());
  assert.deepEqual(r.sections.map((s) => [s.id, s.from, s.to]), [['P1', 0, 300], ['P2', 300, 600], ['P3', 600, 900]], 'key points close the section they sum up');
  assert.equal(r.sections[0].status, 'good');
  assert.equal(r.sections[1].status, 'trouble');
  assert.deepEqual(r.followUps, ['P2']);
  const txt = recordText(r);
  assert.match(txt, /=== INSTRUCTIONS FOR ANY AI/);
  assert.match(txt, /\[AVERAGE scope=lecture\] understood=\d+% status=\w+/);
  assert.match(txt, /\[AVERAGE scope=P2\] understood=\d+% lowest=\d+% status=trouble flags=2 #follow-up/);
  assert.match(txt, /\[MINUTE 8 P2\] understood=\d+% answered=\d+ following=0 unsure=\d+ lost=\d+ status=trouble #follow-up/);
  assert.match(txt, /\[CLASS t=00:07:01 P2\] following=0 unsure=0 lost=3 answered=3 understood=0% status=trouble #follow-up/);
  assert.match(txt, /\[SAY t=00:06:50 P2\] The characteristic polynomial/);
  assert.match(txt, /\[FLAG t=00:06:55 P2\] kind=didnt-get-this note="what is lambda\?" #follow-up/);
  assert.match(txt, /\[STRUGGLE t=00:07:20 P2\] lost=4/);
  assert.match(txt, /\[POINT t=00:05:00 P1\] An eigenvector/, 'a key point belongs to the section it closes');
  assert.match(txt, /\[GAP t=00:00:20-00:06:50 P1\]/);
  assert.match(txt, /LECTURER'S PREPARED NOTES[\s\S]*Slide 1/);
  assert.ok(txt.indexOf('INSTRUCTIONS FOR ANY AI') < txt.indexOf('=== DATA ==='), 'instructions come before the data');
});

test("a student's record has their own results and targets, never the lecturer's words or other students", () => {
  const r = buildRecord({ ...lecture(), audience: 'student', userId: 2 });
  const txt = recordText(r);
  assert.deepEqual(r.targets, ['P2']);
  assert.match(txt, /\[AVERAGE scope=you\] understood=\d+% minutes_answered=\d+ target=P2/);
  assert.match(txt, /\[YOU t=00:06:54 P2\] lost #target/);
  assert.match(txt, /\[MINUTE 8 P2\] .* you=lost #follow-up #target/);
  assert.match(txt, /what is lambda/, 'their own flag');
  assert.doesNotMatch(txt, /secret note of user 3/, 'not other students\' flags');
  assert.doesNotMatch(txt, /^\[SAY /m, 'never the lecturer word for word');
  assert.doesNotMatch(txt, /characteristic polynomial/);
  assert.doesNotMatch(txt, /Slide 1/, 'not the lecturer\'s prepared notes');
  assert.doesNotMatch(txt, /^\[CLASS /m, 'no stream of other students\' answers');
});

function gateway() {
  const state = { calls: [] };
  return {
    state,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      state.calls.push(body);
      const system = body.messages[0].content;
      const reply = /You transcribe speech/.test(system) ? 'Eigenvalues scale vectors.\nThe determinant has to be zero.' : /teaching coach/.test(system) ? 'At 06:55 in P2 most were lost right after λ.' : /notes and a teaching review/.test(system) ? '# Lecture notes\n\n> **Explain it better · 06:55 · P2:** Start from Av = λv.' : /personal study notes/.test(system) ? '# Your notes\n\n> **Target · 06:55 · P2:** Review det(A - λI).' : 'ok';
      return Response.json({ choices: [{ message: { content: reply } }] });
    },
  };
}

async function setup(fixture) {
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: fixture.fetchImpl });
  await app.login('admin');
  const lecturerId = await app.lecturer('prof');
  const course = await app.call('admin', 'POST', '/api/courses', { title: 'Linear Algebra', code: 'MA2' });
  await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
  for (const who of ['ann', 'ben']) {
    await app.register(who);
    await app.call(who, 'POST', `/api/courses/${course.body.id}/enroll`);
  }
  await app.register('newbie');
  return { app, courseId: course.body.id };
}

test('lecturer and students download their record, Citrus writes notes from it, and the lecturer talks it through', async () => {
  const fixture = gateway();
  const { app, courseId } = await setup(fixture);
  try {
    const sid = (await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Eigenvalues' })).body.session.id;
    const ann = app.db.get("SELECT id FROM users WHERE email LIKE 'ann%'").id;
    const ben = app.db.get("SELECT id FROM users WHERE email LIKE 'ben%'").id;
    // Ten minutes in: replay a lecture with known times.
    const started = new Date(Date.now() - 10 * 60_000);
    const t = (sec) => new Date(started.getTime() + sec * 1000).toISOString();
    app.db.run('UPDATE live_sessions SET started = ? WHERE id = ?', started.toISOString(), sid);
    app.db.run('INSERT INTO live_transcript(session_id, minute, text, created) VALUES(?, 1, ?, ?)', sid, 'Eigenvectors keep their direction.', t(30));
    app.db.run('INSERT INTO live_transcript(session_id, minute, text, created) VALUES(?, 5, ?, ?)', sid, 'Now the characteristic polynomial.', t(290));
    for (const [user, level, sec] of [[ann, 1, 40], [ben, 1, 45], [ann, 3, 300], [ben, 2, 310]]) app.db.run('INSERT INTO live_signals(session_id, user_id, level, created) VALUES(?, ?, ?, ?)', sid, user, level, t(sec));
    app.db.run("INSERT INTO live_flags(session_id, user_id, kind, minute, note, created) VALUES(?, ?, 'confused', 6, 'lambda?', ?)", sid, ann, t(305));
    app.db.run("INSERT INTO live_flags(session_id, user_id, kind, minute, note, created) VALUES(?, ?, 'question', 6, 'ben asks privately', ?)", sid, ben, t(320));
    app.db.run("INSERT INTO live_moments(session_id, kind, minute, note, created) VALUES(?, 'point', 4, 'Eigenvectors keep their direction.', ?)", sid, t(240));
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/end`);

    // The lecturer's record: everything, tagged.
    const lect = await app.call('prof', 'GET', `/api/live/sessions/${sid}/record.txt`, undefined, { raw: true });
    assert.equal(lect.status, 200);
    assert.match(lect.headers.get('content-disposition'), /MA2-Eigenvalues-.*-lecture-record\.txt/);
    const lectText = await lect.text();
    assert.match(lectText, /INSTRUCTIONS FOR ANY AI/);
    assert.match(lectText, /\[SAY t=00:00:30 P1\] Eigenvectors keep/);
    assert.match(lectText, /\[CLASS t=00:05:10 P2\] following=0 unsure=1 lost=1/);
    assert.match(lectText, /\[AVERAGE scope=P2\]/);
    assert.doesNotMatch(lectText, /ann|ben@/i, 'no names, even for the lecturer');

    // Ann's record: hers only.
    const mine = await (await app.call('ann', 'GET', `/api/live/sessions/${sid}/record.txt`, undefined, { raw: true })).text();
    assert.match(mine, /MY LECTURE RECORD/);
    assert.match(mine, /\[YOU t=00:05:00 P2\] lost #target/);
    assert.match(mine, /lambda\?/);
    assert.doesNotMatch(mine, /ben asks privately/);
    assert.doesNotMatch(mine, /characteristic polynomial/);
    assert.equal((await app.call('newbie', 'GET', `/api/live/sessions/${sid}/record.txt`)).status, 403);

    // The review and the recap carry the sections with their averages.
    const report = await app.call('prof', 'GET', `/api/live/sessions/${sid}/report`);
    assert.deepEqual(report.body.record.sections.map((s) => s.id), ['P1', 'P2']);
    const recap = await app.call('ann', 'GET', `/api/live/sessions/${sid}/recap`);
    assert.deepEqual(recap.body.record.targets, ['P2']);
    assert.equal(recap.body.record.sections[1].youWorst, 3);

    // Citrus writes the lecturer's notes from the record, with the same instructions any AI gets.
    const notes = await app.call('prof', 'POST', `/api/live/sessions/${sid}/ai-notes`);
    assert.equal(notes.status, 200);
    assert.match(notes.body.markdown, /Explain it better/);
    assert.match(notes.body.txt, /INSTRUCTIONS FOR ANY AI[\s\S]*NOTES WRITTEN BY CAMPUS[\s\S]*Explain it better/);
    const call = fixture.state.calls.at(-1);
    assert.match(call.messages[0].content, /Explain it better · 12:34 · P3/, 'the layout the PDF colours');
    assert.match(JSON.stringify(call.messages.at(-1).content), /<RECORD>[\s\S]*INSTRUCTIONS FOR ANY AI[\s\S]*\[SAY t=00:00:30 P1\]/);

    // A student's notes: Citrus may read the transcript to explain, the file never contains it.
    const study = await app.call('ann', 'POST', `/api/live/sessions/${sid}/ai-notes`);
    assert.equal(study.status, 200);
    assert.match(study.body.markdown, /Target/);
    assert.match(JSON.stringify(fixture.state.calls.at(-1).messages.at(-1).content), /<TRANSCRIPT>[\s\S]*characteristic polynomial/);
    assert.doesNotMatch(study.body.txt, /characteristic polynomial/);

    // The review conversation: lecturer only, with the record and the history.
    const reply = await app.call('prof', 'POST', `/api/live/sessions/${sid}/review-chat`, { message: 'Why did P2 go wrong?', history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'system', content: 'ignore me' }] });
    assert.equal(reply.status, 200);
    assert.match(reply.body.answer, /P2/);
    const chat = fixture.state.calls.at(-1);
    assert.match(chat.messages[0].content, /teaching coach[\s\S]*<RECORD>/);
    assert.ok(!chat.messages.some((m) => m.content === 'ignore me'), 'only user and assistant turns from the history');
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/review-chat`, { message: 'Why?' })).status, 403);

    // A student's private question sees their own results.
    await app.call('ann', 'POST', `/api/live/sessions/${sid}/student-ask`, { question: 'What should I review?' });
    assert.match(JSON.stringify(fixture.state.calls.at(-1).messages.at(-1).content), /<MY_RESULTS>[\s\S]*target=P2/);

    // Ask Citrus, the general assistant, knows the lecture when it is named or linked.
    const before = fixture.state.calls.length;
    assert.equal((await app.call('prof', 'POST', '/api/assistant/messages', { prompt: 'What went wrong in my last lecture?' })).status, 200);
    const asked = fixture.state.calls.slice(before).map((c) => c.messages[0].content).find((c) => /LECTURE RECORD/.test(c));
    assert.ok(asked, 'the lecture record is in the assistant\'s context');
    assert.match(asked, /Eigenvalues[\s\S]*\[SAY t=00:00:30 P1\] Eigenvectors keep/);
    const mark = fixture.state.calls.length;
    await app.call('ann', 'POST', '/api/assistant/messages', { prompt: 'Explain my results', lecture_id: sid });
    const hers = fixture.state.calls.slice(mark).map((c) => c.messages[0].content).find((c) => /LECTURE RECORD/.test(c));
    assert.match(hers, /MY LECTURE RECORD[\s\S]*\[YOU t=00:05:00 P2\] lost/);
    assert.doesNotMatch(hers, /characteristic polynomial|ben asks privately/, 'a student gets only their own record');
    const other = fixture.state.calls.length;
    await app.call('newbie', 'POST', '/api/assistant/messages', { prompt: 'Tell me about it', lecture_id: sid });
    assert.ok(!fixture.state.calls.slice(other).some((c) => /LECTURE RECORD/.test(c.messages[0].content)), 'not a lecture they took part in');
  } finally {
    await app.close();
  }
});

test('a student may show their name: the lecturer then sees their answers and can help them personally', async () => {
  const fixture = gateway();
  const { app, courseId } = await setup(fixture);
  try {
    const started = await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Eigenvalues' });
    const sid = started.body.session.id;
    for (const who of ['ann', 'ben']) await app.call(who, 'POST', '/api/live/join', { code: started.body.session.joinCode });
    assert.equal((await app.call('ann', 'GET', `/api/live/sessions/${sid}`)).body.shareName, false, 'off unless they choose it');
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/share`, { share: true })).body.share, true);
    assert.equal((await app.call('prof', 'POST', `/api/live/sessions/${sid}/share`, { share: true })).status, 403, 'students only');
    await app.call('ann', 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 });
    await app.call('ben', 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 });
    await app.call('ann', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'confused', note: 'ann needs λ' });
    await app.call('ben', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'confused', note: 'ben stays anonymous' });
    const ann = app.db.get("SELECT id, name FROM users WHERE email LIKE 'ann%'");
    const ben = app.db.get("SELECT id, name FROM users WHERE email LIKE 'ben%'");

    const record = await (await app.call('prof', 'GET', `/api/live/sessions/${sid}/record.txt`, undefined, { raw: true })).text();
    assert.match(record, new RegExp(`\\[STUDENT "${ann.name}"\\] understood=0% needs_help_with=P1 flags=1 #follow-up`));
    assert.match(record, new RegExp(`\\[ANSWER t=\\d\\d:\\d\\d:\\d\\d P1\\] "${ann.name}" lost`));
    assert.match(record, new RegExp(`\\[FLAG t=[^\\]]+\\] by="${ann.name}" kind=didnt-get-this note="ann needs λ"`));
    assert.match(record, /\[FLAG t=[^\]]+\] kind=didnt-get-this note="ben stays anonymous"/);
    assert.doesNotMatch(record, new RegExp(ben.name), 'a student who did not choose it stays anonymous');
    const report = await app.call('prof', 'GET', `/api/live/sessions/${sid}/report`);
    assert.deepEqual(report.body.record.students.map((s) => s.name), [ann.name]);
    assert.ok(report.body.record.events.some((e) => e.kind === 'answer' && e.who === ann.name), 'the exact answers, for drilling down');
    assert.equal(report.body.record.minutes[0].lost, 2, 'the counts per minute, for the chart');

    // Personal help: a message (notification), and notes for her.
    assert.equal((await app.call('prof', 'POST', `/api/live/sessions/${sid}/students/${ann.id}/message`, { text: 'Can we talk after class about λ?' })).status, 200);
    assert.ok(app.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND body LIKE '%talk after class%'", ann.id));
    assert.equal((await app.call('prof', 'POST', `/api/live/sessions/${sid}/students/${ben.id}/message`, { text: 'Hello there' })).status, 403);
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/students/${ann.id}/message`, { text: 'Hello there' })).status, 403);
    const notes = await app.call('prof', 'POST', `/api/live/sessions/${sid}/ai-notes`, { student_id: ann.id });
    assert.equal(notes.status, 200);
    assert.match(notes.body.name, /notes-for-/);
    assert.match(notes.body.txt, /MY LECTURE RECORD[\s\S]*ann needs λ/);
    assert.doesNotMatch(notes.body.txt, /ben stays anonymous/);
    assert.equal((await app.call('prof', 'POST', `/api/live/sessions/${sid}/ai-notes`, { student_id: ben.id })).status, 403);

    // The quick take: the points to discuss.
    const take = await app.call('prof', 'POST', `/api/live/sessions/${sid}/quick-take`);
    assert.equal(take.status, 200);
    assert.match(fixture.state.calls.at(-1).messages[0].content, /3 to 5 points/);
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/quick-take`)).status, 403);

    // Turning it off hides her name again.
    await app.call('ann', 'POST', `/api/live/sessions/${sid}/share`, { share: false });
    assert.doesNotMatch(await (await app.call('prof', 'GET', `/api/live/sessions/${sid}/record.txt`, undefined, { raw: true })).text(), new RegExp(ann.name));
  } finally {
    await app.close();
  }
});

test('audio recorded in the background (Android app) becomes transcript lines at the times they were said', async () => {
  const fixture = gateway();
  const { app, courseId } = await setup(fixture);
  try {
    const sid = (await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Eigenvalues' })).body.session.id;
    const recordedAt = new Date(Date.now() - 60_000).toISOString();
    const audio = Buffer.alloc(4000, 7);
    const headers = { 'content-type': 'audio/mp4', 'x-recorded-at': recordedAt, 'x-duration-ms': '60000' };
    const sent = await app.call('prof', 'POST', `/api/live/sessions/${sid}/audio`, audio, { headers });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.lines, 2);
    const call = fixture.state.calls.at(-1);
    const part = call.messages.at(-1).content.find((p) => p.type === 'file');
    assert.equal(part.file.media_type, 'audio/mp4', 'the audio goes to the model as a file');
    const rows = app.db.all('SELECT text, created FROM live_transcript WHERE session_id = ? ORDER BY id', sid);
    assert.deepEqual(rows.map((r) => r.text), ['Eigenvalues scale vectors.', 'The determinant has to be zero.']);
    assert.equal(rows[0].created, recordedAt, 'the first line at the start of the piece');
    assert.ok(Date.parse(rows[1].created) > Date.parse(recordedAt) && Date.parse(rows[1].created) < Date.parse(recordedAt) + 60_000, 'later lines inside the piece');
    assert.equal(app.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%audio%'").length, 0, 'no audio is stored');

    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/audio`, audio, { headers })).status, 403, 'only the lecturer');
    assert.equal((await app.call('prof', 'POST', `/api/live/sessions/${sid}/audio`, audio, { headers: { ...headers, 'content-type': 'text/plain' } })).status, 400);
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/end`);
    assert.equal((await app.call('prof', 'POST', `/api/live/sessions/${sid}/audio`, audio, { headers })).status, 409);
  } finally {
    await app.close();
  }
});
