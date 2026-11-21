'use strict';
/**
 * Everyone accepts the Data Service and Privacy Agreement to use the app (students, guests, lecturers,
 * administrators), and again when it changes. Until they do, nothing but reading it, accepting it, downloading their
 * data and deleting their account works.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, PASSWORD } = require('./helpers');
const { VERSION, agreementFor } = require('../src/modules/legal/agreement');

const on = { CAMPUS_REQUIRE_AGREEMENT: 'on' };
const accept = (app, who, version = VERSION) => app.call(who, 'POST', '/api/agreement/accept', { version, accept: true });

test('the agreement is public, complete and has no blanks, no personal name, and the real hosting locations', async () => {
  const app = await startApp({ env: on });
  try {
    const r = await app.call('visitor', 'GET', '/api/agreement?lang=en');
    assert.equal(r.status, 200);
    assert.equal(r.body.version, VERSION);
    const text = r.body.markdown;
    for (const part of ['Part A: for everyone', 'Part B: students and guests', 'Part C: lecturers', 'Part D: administrators']) assert.match(text, new RegExp(part), `a visitor reads ${part}`);
    assert.match(text, /eu-west-1 region \(Ireland\)/, 'where the database runs');
    assert.match(text, /Vercel, Dublin \(Ireland\)/);
    assert.match(text, /365 days/, 'the institution’s real retention');
    assert.doesNotMatch(text, /\[[A-Za-z]/, 'no placeholder in square brackets is left');
    assert.doesNotMatch(text, /Mangena/i);
    assert.match(text, /Controller \| (?!\[)/);
    // A visitor can ask for one part.
    const lecturer = await app.call('visitor', 'GET', '/api/agreement?lang=en&role=lecturer');
    assert.match(lecturer.body.markdown, /Part C: lecturers/);
    assert.doesNotMatch(lecturer.body.markdown, /Part D: administrators/);
  } finally {
    await app.close();
  }
});

test('creating an account and joining as a guest both need the agreement, and are recorded', async () => {
  const app = await startApp({ env: on });
  try {
    await app.login('admin');
    const bad = await app.call('ann', 'POST', '/api/register', { name: 'Ann Person', email: 'ann@test.invalid', password: PASSWORD });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Agreement/i);
    const ok = await app.call('ann', 'POST', '/api/register', { name: 'Ann Person', email: 'ann@test.invalid', password: PASSWORD, agree: true });
    assert.equal(ok.status, 201);
    assert.equal((await app.call('ann', 'GET', '/api/courses')).status, 200, 'accepted at registration: the app works at once');
    const row = app.db.get('SELECT agreement_version, agreement_at FROM users WHERE email = ?', 'ann@test.invalid');
    assert.equal(row.agreement_version, VERSION);
    assert.ok(row.agreement_at);
    assert.deepEqual(app.db.all('SELECT version, role, via FROM agreement_acceptances WHERE user_id = ?', ok.body.user.id).map((r) => ({ ...r })), [{ version: VERSION, role: 'student', via: 'register' }]);

    assert.equal((await app.call('g', 'POST', '/api/guest', { name: 'Lena' })).status, 400, 'a guest must accept too');
    const guest = await app.call('g', 'POST', '/api/guest', { name: 'Lena', agree: true });
    assert.equal(guest.status, 201);
    assert.equal((await app.call('g', 'GET', '/api/courses')).status, 200);
    assert.deepEqual(app.db.all('SELECT role, via FROM agreement_acceptances WHERE user_id = ?', guest.body.user.id).map((r) => ({ ...r })), [{ role: 'guest', via: 'guest' }]);
  } finally {
    await app.close();
  }
});

test('until the current version is accepted nothing works but reading it, accepting it, exporting data and deleting the account', async () => {
  const app = await startApp({ env: on });
  try {
    // The seeded administrator has never accepted.
    assert.equal((await app.call('admin', 'POST', '/api/login', { email: 'admin@test.invalid', password: 'Admin-password-for-tests-1' })).status, 200);
    const blocked = await app.call('admin', 'GET', '/api/courses');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.details.code, 'agreement');
    assert.equal((await app.call('admin', 'POST', '/api/courses', { title: 'X', code: 'X1' })).status, 403);

    const boot = await app.call('admin', 'GET', '/api/bootstrap');
    assert.deepEqual(boot.body.agreement, { required: true, version: VERSION });
    const read = await app.call('admin', 'GET', '/api/agreement?lang=en');
    assert.equal(read.body.required, true);
    assert.match(read.body.markdown, /Part D: administrators/);
    assert.doesNotMatch(read.body.markdown, /Part C: lecturers/, 'an administrator is shown their own part');
    assert.equal((await app.call('admin', 'GET', '/api/me/export', undefined, { raw: true })).status, 200, 'taking your data never waits');

    // It must be the current version and a real acceptance.
    assert.equal((await accept(app, 'admin', 'an-old-version')).status, 409);
    assert.equal((await app.call('admin', 'POST', '/api/agreement/accept', { version: VERSION })).status, 400);
    const done = await accept(app, 'admin');
    assert.equal(done.status, 200);
    assert.equal((await app.call('admin', 'GET', '/api/courses')).status, 200);
    assert.deepEqual((await app.call('admin', 'GET', '/api/bootstrap')).body.agreement, { required: false, version: VERSION });
    assert.equal((await app.call('admin', 'GET', '/api/agreement?lang=en')).body.accepted.current, true);

    // The text changes: everybody is asked again.
    app.db.run("UPDATE users SET agreement_version = '2020-01-01'");
    assert.equal((await app.call('admin', 'GET', '/api/courses')).status, 403, 'a new version has to be accepted again');
    assert.equal((await app.call('admin', 'GET', '/api/agreement?lang=en')).body.accepted.current, false);
    await accept(app, 'admin');
    assert.equal((await app.call('admin', 'GET', '/api/courses')).status, 200);
    assert.equal(app.db.all("SELECT 1 FROM agreement_acceptances WHERE version = ?", VERSION).length, 2, 'every acceptance is kept');
  } finally {
    await app.close();
  }
});

test('each role reads its own part, and the institution’s own details are filled in', async () => {
  const app = await startApp({ env: on });
  try {
    await app.login('admin');
    await accept(app, 'admin');
    await app.call('admin', 'PATCH', '/api/admin/settings', { legalController: 'Example University, 1 Campus Road, 12345 Town', legalDpo: 'Dr Data, dpo@example.test', legalContact: 'privacy@example.test', legalAuthority: 'Example State Data Protection Commissioner', lectureTextRetentionDays: 90 });
    await app.register('prof');
    app.db.run("UPDATE users SET role = 'lecturer' WHERE email = 'prof@test.invalid'");
    await accept(app, 'prof');
    const lecturer = (await app.call('prof', 'GET', '/api/agreement?lang=en')).body.markdown;
    assert.match(lecturer, /Part C: lecturers/);
    assert.doesNotMatch(lecturer, /Part B: students|Part D: administrators/);
    assert.match(lecturer, /Controller \| Example University, 1 Campus Road, 12345 Town/);
    assert.match(lecturer, /dpo@example\.test/);
    assert.match(lecturer, /privacy@example\.test/);
    assert.match(lecturer, /Example State Data Protection Commissioner/);
    assert.match(lecturer, /\| 90 days after they were written/);

    await app.register('stu');
    await accept(app, 'stu');
    const student = (await app.call('stu', 'GET', '/api/agreement?lang=en')).body.markdown;
    assert.match(student, /Part B: students and guests/);
    assert.doesNotMatch(student, /Part C: lecturers|Part D: administrators/);
    // Only administrators set the details.
    assert.equal((await app.call('stu', 'PATCH', '/api/admin/settings', { legalController: 'Me' })).status, 403);
  } finally {
    await app.close();
  }
});

test('retention of 0 reads as "until it is deleted" and the text names the institution when no details are entered', () => {
  const doc = agreementFor({ role: 'student', lang: 'en', institution: 'Example University', lectureTextRetentionDays: 0 }).markdown;
  assert.match(doc, /\| until they are deleted \(the institution's setting\) \|/);
  assert.match(agreementFor({ role: 'student', lang: 'de', lectureTextRetentionDays: 0 }).markdown, /\| bis sie gelöscht werden \(Einstellung der Einrichtung\) \|/);
  assert.match(doc, /Controller \| Example University/);
  assert.match(doc, /data-protection officer of your institution/);
  assert.match(agreementFor({ role: 'student', lang: 'de', institution: 'Beispiel-Hochschule' }).markdown, /Verantwortlicher \| Beispiel-Hochschule/);
  assert.match(agreementFor({ role: 'student', lang: 'de' }).markdown, /Verantwortlicher \| Ihre Einrichtung/, 'without a name the German text says so in German');
});

test('German comes first: it is the default, with the institution’s details and each role’s own part, and English one switch away', async () => {
  const app = await startApp({ env: on });
  try {
    // A visitor, nobody asked for a language: German, all parts, no blanks, no personal name.
    const visitor = (await app.call('visitor', 'GET', '/api/agreement')).body;
    assert.equal(visitor.language, 'de');
    assert.deepEqual(visitor.languages, ['de', 'en'], 'German listed first');
    assert.match(visitor.title, /Datendienst- und Datenschutzvereinbarung/);
    for (const part of ['Teil A: für alle', 'Teil B: Studierende und Gäste', 'Teil C: Dozierende', 'Teil D: Administratorinnen und Administratoren']) assert.match(visitor.markdown, new RegExp(part));
    assert.match(visitor.markdown, /eu-west-1 \(Irland\)/, 'where the database runs');
    assert.match(visitor.markdown, /Maßgeblich ist die deutsche Fassung/);
    assert.doesNotMatch(visitor.markdown, /\[[A-Za-zÄÖÜäöü]|Mangena/);

    // The same agreement in English on request, with the same version.
    const english = (await app.call('visitor', 'GET', '/api/agreement?lang=en')).body;
    assert.equal(english.language, 'en');
    assert.equal(english.version, visitor.version);

    // The institution's own details and retention appear in the German text too.
    await app.login('admin');
    await accept(app, 'admin');
    await app.call('admin', 'PATCH', '/api/admin/settings', { legalController: 'Beispiel-Hochschule, Campusweg 1, 12345 Stadt', legalDpo: 'Dr. Daten, datenschutz@beispiel.test', legalContact: 'datenschutz@beispiel.test', legalAuthority: 'Landesbeauftragter für den Datenschutz', lectureTextRetentionDays: 90 });
    const admin = (await app.call('admin', 'GET', '/api/agreement')).body.markdown;
    assert.match(admin, /Teil D: Administratorinnen und Administratoren/);
    assert.doesNotMatch(admin, /Teil C: Dozierende/);
    assert.match(admin, /Verantwortlicher \| Beispiel-Hochschule, Campusweg 1, 12345 Stadt/);
    assert.match(admin, /datenschutz@beispiel\.test/);
    assert.match(admin, /\| 90 Tage nach ihrer Entstehung/);

    // A person whose own language is English gets English unless they ask for German.
    await app.register('ann');
    await app.call('ann', 'PATCH', '/api/me', { preferences: { language: 'en' } });
    assert.equal((await app.call('ann', 'GET', '/api/agreement')).body.language, 'en');
    assert.equal((await app.call('ann', 'GET', '/api/agreement?lang=de')).body.language, 'de');
  } finally {
    await app.close();
  }
});
