'use strict';
/** A QR code for every lecture (the encoder, the lecture's own link, joining with it with or without an account), and the date picker's calendar. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startApp } = require('./helpers');

const loadQr = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'core', 'qr.js')).href);
const hashOf = (qr) => crypto.createHash('sha256').update(qr.rows.map((r) => r.join('')).join('\n')).digest('hex');

test('QR codes come out exactly as the reference encoder makes them', async () => {
  const { qrCode, qrSvg } = await loadQr();
  // Version, level, mask and every module, from Project Nayuki's QR Code generator (Python) for the same text.
  const golden = [
    ['https://campusos-mdu.vercel.app/join/Lk7Qm2xPa9wZ', 'M', 4, 'M', 2, '2dffd4d57af429db05216f52934284544369b484d0c8c2e76564698b32c58dbe'],
    ['Grüße aus dem Hörsaal ✓', 'Q', 3, 'Q', 3, 'a91343d5b02bc82a3521fcaab631e5bb7c255f38b35c8e6f6dd2862b568c9345'],
    ['x'.repeat(150), 'M', 8, 'M', 2, '9782fa7f0642d3e6b22295c01fc9e2fe9a0f19d22af2cf7b3964dcb6a932e44e'], // version information
    ['0123456789'.repeat(60), 'L', 17, 'L', 2, '778526ae236ba4397cce7373b4ba4f89a8ebdf6a8f8a77066679e811c7c90aa6'], // many blocks
  ];
  for (const [text, ecl, version, level, mask, hash] of golden) {
    const qr = qrCode(text, { ecl });
    assert.deepEqual([qr.version, qr.ecl, qr.mask, qr.size], [version, level, mask, version * 4 + 17], text.slice(0, 20));
    assert.equal(hashOf(qr), hash, `${text.slice(0, 20)}: every module matches`);
  }
  // Finder patterns in three corners, light in the fourth.
  const qr = qrCode('https://campusos-mdu.vercel.app/join/Lk7Qm2xPa9wZ');
  for (const [x, y] of [[0, 0], [qr.size - 7, 0], [0, qr.size - 7]]) assert.equal(qr.dark(x + 3, y + 3) && qr.dark(x, y) && !qr.dark(x + 1, y + 1), true);
  assert.throws(() => qrCode('x'.repeat(3000)), /Too long/);

  const svg = qrSvg('https://example.test/join/abc', { label: 'Join <the> lecture' });
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 37 37"/, 'version 2 with a quiet zone of 4');
  assert.match(svg, /aria-label="Join &lt;the&gt; lecture"/);
});

async function setup() {
  const app = await startApp();
  await app.login('admin');
  const lecturerId = await app.lecturer('prof');
  await app.lecturer('other');
  const course = await app.call('admin', 'POST', '/api/courses', { title: 'Neural Networks', code: 'NN201' });
  await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
  const lecture = await app.call('prof', 'POST', `/api/courses/${course.body.id}/lectures`, { topic: 'Week 6: Backpropagation', room: 'HSG 001' });
  assert.equal(lecture.status, 201, JSON.stringify(lecture.body));
  return { app, courseId: course.body.id, lectureId: lecture.body.id };
}

test('every lecture has a link of its own behind its QR code; anyone can join with it, before or during the lecture', async () => {
  const { app, courseId, lectureId } = await setup();
  try {
    // Only the lecturer gets the link. It is made once and then stays the same.
    const link = await app.call('prof', 'GET', `/api/live/lectures/${lectureId}/link`);
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.match(link.body.path, /^\/join\/[A-Za-z0-9_-]{12}$/);
    assert.equal(link.body.lecture.title, 'Week 6: Backpropagation');
    assert.equal(link.body.live, false);
    assert.equal((await app.call('prof', 'GET', `/api/live/lectures/${lectureId}/link`)).body.token, link.body.token);
    await app.register('ann');
    assert.equal((await app.call('ann', 'GET', `/api/live/lectures/${lectureId}/link`)).status, 403);
    assert.equal((await app.call('other', 'GET', `/api/live/lectures/${lectureId}/link`)).status, 403, 'not another lecturer');
    assert.equal((await app.call('anon', 'GET', `/api/live/lectures/${lectureId}/link`)).status, 401);
    const token = link.body.token;

    // Scanning it signed out shows what it opens, nothing more.
    const info = await app.call('anon', 'GET', `/api/live/links/${token}`);
    assert.equal(info.status, 200);
    assert.deepEqual(info.body, { lecture: { title: 'Week 6: Backpropagation', starts: null, ends: null, room: 'HSG 001' }, course: { code: 'NN201', title: 'Neural Networks' }, live: false });
    assert.equal((await app.call('anon', 'GET', '/api/live/links/AAAAAAAAAAAA')).status, 404);
    assert.equal((await app.call('anon', 'GET', '/api/live/links/short')).status, 404);

    // Before the lecture (the code on a slide): a student joins the course, and the lecture opens when it starts.
    const early = await app.call('ann', 'POST', '/api/live/join', { token });
    assert.equal(early.status, 200, JSON.stringify(early.body));
    assert.deepEqual(early.body, { session: null, course_id: courseId, title: 'Week 6: Backpropagation', live: false });
    assert.ok(app.db.get('SELECT 1 AS yes FROM enrollments WHERE course_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)', courseId, 'ann@test.invalid'));

    // The projector shows the same link while the lecture runs.
    const started = await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, lecture_id: lectureId });
    assert.equal(started.status, 201);
    assert.equal(started.body.session.joinLink, link.body.path);
    assert.equal((await app.call('anon', 'GET', `/api/live/links/${token}`)).body.live, true);
    const sid = started.body.session.id;

    // No account: a guest from the QR code, with the name they typed, in the lecture's university.
    const guest = await app.call('lena', 'POST', '/api/guest', { lecture: token, name: '  Lena \n  Gast ' });
    assert.equal(guest.status, 201, JSON.stringify(guest.body));
    assert.equal(guest.body.user.name, 'Lena Gast');
    assert.equal(guest.body.user.role, 'student');
    assert.equal(guest.body.user.auth_provider, 'guest');
    const joined = await app.call('lena', 'POST', '/api/live/join', { token });
    assert.deepEqual(joined.body, { session: sid, course_id: courseId, title: 'Week 6: Backpropagation', live: true });
    assert.equal((await app.call('lena', 'POST', `/api/live/sessions/${sid}/signal`, { level: 2 })).status, 200, 'and takes part like any student');
    assert.equal((await app.call('kim', 'POST', '/api/guest', {})).body.user.name, 'Guest', 'a name is optional');
    assert.equal((await app.call('max', 'POST', '/api/guest', { lecture: 'AAAAAAAAAAAA' })).status, 404, 'a wrong code makes no guest');

    await app.call('ann', 'POST', '/api/live/join', { token });
    assert.equal((await app.call('prof', 'GET', `/api/live/sessions/${sid}`)).body.present, 2, 'both are counted in the room');
    assert.equal((await app.call('other', 'POST', '/api/live/join', { token })).status, 403, 'staff of other courses are not students of it');

    // The six-digit code still works the same way.
    assert.equal((await app.call('kim', 'POST', '/api/live/join', { code: started.body.session.joinCode })).body.live, true);

    // A new link: the old QR code stops working, and the lecture opened again keeps the new one.
    const fresh = await app.call('prof', 'POST', `/api/live/lectures/${lectureId}/link`);
    assert.notEqual(fresh.body.token, token);
    assert.equal((await app.call('anon', 'GET', `/api/live/links/${token}`)).status, 404);
    assert.equal((await app.call('ann', 'POST', '/api/live/join', { token })).status, 404);
    await app.call('prof', 'POST', `/api/live/sessions/${sid}/end`);
    const again = await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, lecture_id: lectureId });
    assert.equal(again.body.session.joinLink, fresh.body.path);
  } finally {
    await app.close();
  }
});

test('the date picker shows whole weeks from Monday and finds next Monday', async () => {
  const { monthGrid, splitValue, nextMonday, addDays } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'features', 'date-picker.js')).href);
  const nov = monthGrid(2026, 10); // November 2026 starts on a Sunday
  assert.equal(nov.length, 42);
  assert.equal(nov[0], '2026-10-26', 'the Monday before');
  assert.equal(nov[6], '2026-11-01');
  assert.equal(nov[41], '2026-12-06');
  assert.equal(monthGrid(2027, 1)[0], '2027-02-01', 'February 2027 starts on a Monday: no days from January');
  assert.equal(monthGrid(2028, 1).filter((d) => d.startsWith('2028-02')).length, 29, 'leap year');
  assert.deepEqual(splitValue('2026-11-19T10:30'), { day: '2026-11-19', time: '10:30' });
  assert.deepEqual(splitValue('2026-11-19'), { day: '2026-11-19', time: '' });
  assert.deepEqual(splitValue('soon'), { day: '', time: '' });
  assert.equal(nextMonday('2026-11-16'), '2026-11-23', 'a Monday: the one after');
  assert.equal(nextMonday('2026-11-22'), '2026-11-23', 'a Sunday: tomorrow');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
