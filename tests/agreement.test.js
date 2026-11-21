'use strict';
/**
 * Terms of Use and Privacy: everyone accepts them to use the app (students, guests, lecturers, administrators), each
 * in their own version, in German first with English second, and again when they change. Until they do, nothing but
 * reading them, accepting them, downloading their data and deleting their account works.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, PASSWORD } = require('./helpers');
const { VERSION, agreementFor, ROLES } = require('../src/modules/legal/agreement');

const on = { CAMPUS_REQUIRE_AGREEMENT: 'on' };
const accept = (app, who, version = VERSION) => app.call(who, 'POST', '/api/agreement/accept', { version, accept: true });
const get = (app, who, query = '') => app.call(who, 'GET', `/api/agreement${query}`);

test('it opens in German with English second, in four sections, with the real hosting and no blanks or personal names', async () => {
  const app = await startApp({ env: on });
  try {
    const r = (await get(app, 'visitor')).body;
    assert.equal(r.language, 'de', 'German first, whatever the interface language is');
    assert.deepEqual(r.languages, ['de', 'en']);
    assert.equal(r.version, VERSION);
    assert.equal(r.title, 'Nutzungsbedingungen und Datenschutz');
    assert.deepEqual(r.sections.map((s) => s.id), ['terms', 'privacy', 'cookies', 'retention']);
    assert.deepEqual(r.sections.map((s) => s.title), ['Nutzungsbedingungen', 'Datenschutzerklärung', 'Cookie-Richtlinie', 'Aufbewahrung und Löschung']);
    assert.equal(r.summary.length, 5, 'a short version first');
    assert.match(r.markdown, /eu-west-1, Dublin \(Irland\)/, 'where the database runs');
    assert.match(r.markdown, /Dublin \(Irland\)/);
    assert.match(r.markdown, /365 Tage/, 'the institution’s real retention');
    assert.match(r.markdown, /Maßgeblich ist die deutsche Fassung/);
    assert.doesNotMatch(r.markdown, /\[[A-Za-zÄÖÜäöü]|Mangena|Campus ?OS/i);

    const en = (await get(app, 'visitor', '?lang=en')).body;
    assert.equal(en.language, 'en');
    assert.deepEqual(en.sections.map((s) => s.title), ['Terms of use', 'Privacy policy', 'Cookie policy', 'Data retention']);
    assert.match(en.markdown, /The German version is the binding one|German version is the binding one/);
    assert.equal(en.version, r.version, 'one version for both languages');
  } finally {
    await app.close();
  }
});

test('each kind of user reads their own text, and only theirs', () => {
  const text = (role, lang = 'de') => agreementFor({ role, lang, institution: 'Beispiel-Hochschule' });
  const all = ROLES.map((r) => [r, text(r)]);
  for (const [role, d] of all) {
    assert.equal(d.role, role);
    assert.doesNotMatch(d.markdown, /Teil [A-D]\b/, `${role}: no references to other parts`);
  }
  const body = (role) => text(role).markdown;
  // Student: courses and lecture answers; no account-less guest text, nothing about lecturers' duties.
  assert.match(body('student'), /Ihre Antworten gehören Ihnen/);
  assert.doesNotMatch(body('student'), /Anhang III|24 Stunden|Wegwerf-Konto/);
  // Guest: a throwaway access, 30 days, no account data, no courses.
  assert.match(body('guest'), /Wegwerf-Konto/);
  assert.match(body('guest'), /30 Tagen/);
  assert.doesNotMatch(body('guest'), /Hochschul-E-Mail-Adresse, Passwort|Anwesenheitskontrolle|Anhang III/);
  // Lecturer: their own speech and recordings, no assessment use.
  assert.match(body('lecturer'), /Anhang III/);
  assert.match(body('lecturer'), /Was Sie in der Vorlesung sagen/);
  assert.doesNotMatch(body('lecturer'), /Wegwerf-Konto|Protokoll der Administration/);
  // Administrator: powers, incidents within 24 hours, the log.
  assert.match(body('admin'), /24 Stunden/);
  assert.match(body('admin'), /Protokoll der Administration/);
  assert.doesNotMatch(body('admin'), /Was Sie in der Vorlesung sagen/);
  // Same in English.
  assert.match(text('lecturer', 'en').markdown, /Annex III/);
  assert.match(text('guest', 'en').markdown, /throwaway account/);
  assert.match(text('admin', 'en').markdown, /within 24 hours/);
});

test('cookies, privacy and retention are each covered, for every user', () => {
  for (const lang of ['de', 'en']) {
    for (const role of ROLES) {
      const d = agreementFor({ role, lang, institution: 'X' });
      const by = Object.fromEntries(d.sections.map((s) => [s.id, s.markdown]));
      assert.match(by.cookies, /campus_session/, `${lang} ${role}: the cookie is named`);
      assert.match(by.cookies, /TDDDG/, `${lang} ${role}: why no banner is needed`);
      assert.match(by.cookies, /campus-lang/);
      assert.match(by.privacy, /Art\. 6 Abs\. 1 lit\. [ae] DSGVO|Art\. 6\(1\)\([ae]\) GDPR/);
      assert.match(by.privacy, /Art\. 18 und 21 DSGVO|Art\. 18 and 21 GDPR/);
      assert.match(by.retention, /\| (?:Anmeldesitzungen|Sign-in sessions) \|/);
      assert.match(by.retention, /\| (?:Ihre Zustimmungen|Your acceptances) /);
    }
  }
  // The retention is the institution's own number, and 0 reads as "until deleted".
  assert.match(agreementFor({ role: 'lecturer', lang: 'de', lectureTextRetentionDays: 90 }).markdown, /\| 90 Tage nach ihrer Entstehung/);
  assert.match(agreementFor({ role: 'lecturer', lang: 'en', lectureTextRetentionDays: 0 }).markdown, /\| until they are deleted \(the institution's setting\) \|/);
  assert.match(agreementFor({ role: 'lecturer', lang: 'de', lectureTextRetentionDays: 0 }).markdown, /\| bis sie gelöscht werden \(Einstellung der Einrichtung\) \|/);
});

test('the German and English texts have the same sections, tables and version, and no English is left in the German', () => {
  for (const role of ROLES) {
    const de = agreementFor({ role, lang: 'de', institution: 'Beispiel-Hochschule' });
    const en = agreementFor({ role, lang: 'en', institution: 'Example University' });
    const shape = (d) => d.sections.map((s) => [s.id, (s.markdown.match(/^### /gm) || []).length, (s.markdown.match(/^\|/gm) || []).length]);
    assert.deepEqual(shape(de), shape(en), `${role}: the same headings and table rows`);
    assert.equal(de.summary.length, en.summary.length);
    assert.doesNotMatch(de.markdown, /\b(?:Your institution|the institution|You must|Terms of use)\b/, `${role}: no English left in the German`);
    assert.doesNotMatch(en.markdown, /\b(?:Ihre Einrichtung|Sie müssen|Nutzungsbedingungen)\b/, `${role}: no German left in the English`);
  }
});

test('creating an account and joining as a guest both need the terms, and are recorded', async () => {
  const app = await startApp({ env: on });
  try {
    await app.login('admin');
    const bad = await app.call('ann', 'POST', '/api/register', { name: 'Ann Person', email: 'ann@test.invalid', password: PASSWORD });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /terms of use/i);
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
    // A guest reads the guest version.
    assert.equal((await get(app, 'g')).body.role, 'guest');
  } finally {
    await app.close();
  }
});

test('until the current version is accepted nothing works but reading it, accepting it, exporting data and deleting the account', async () => {
  const app = await startApp({ env: on });
  try {
    assert.equal((await app.call('admin', 'POST', '/api/login', { email: 'admin@test.invalid', password: 'Admin-password-for-tests-1' })).status, 200);
    const blocked = await app.call('admin', 'GET', '/api/courses');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.details.code, 'agreement');
    assert.equal((await app.call('admin', 'POST', '/api/courses', { title: 'X', code: 'X1' })).status, 403);

    const boot = await app.call('admin', 'GET', '/api/bootstrap');
    assert.deepEqual(boot.body.agreement, { required: true, version: VERSION });
    const read = (await get(app, 'admin')).body;
    assert.equal(read.required, true);
    assert.equal(read.role, 'admin');
    assert.equal(read.roleLabel, 'Administration');
    assert.equal(read.language, 'de', 'German first, even for an administrator whose language is English');
    assert.equal((await app.call('admin', 'GET', '/api/me/export', undefined, { raw: true })).status, 200, 'taking your data never waits');

    assert.equal((await accept(app, 'admin', 'an-old-version')).status, 409);
    assert.equal((await app.call('admin', 'POST', '/api/agreement/accept', { version: VERSION })).status, 400);
    assert.equal((await accept(app, 'admin')).status, 200);
    assert.equal((await app.call('admin', 'GET', '/api/courses')).status, 200);
    assert.deepEqual((await app.call('admin', 'GET', '/api/bootstrap')).body.agreement, { required: false, version: VERSION });
    assert.equal((await get(app, 'admin')).body.accepted.current, true);

    // The text changes: everybody is asked again.
    app.db.run("UPDATE users SET agreement_version = '2020-01-01'");
    assert.equal((await app.call('admin', 'GET', '/api/courses')).status, 403, 'a new version has to be accepted again');
    assert.equal((await get(app, 'admin')).body.accepted.current, false);
    await accept(app, 'admin');
    assert.equal((await app.call('admin', 'GET', '/api/courses')).status, 200);
    assert.equal(app.db.all('SELECT 1 FROM agreement_acceptances WHERE version = ?', VERSION).length, 2, 'every acceptance is kept');
  } finally {
    await app.close();
  }
});

test('the institution’s own details and retention appear in the person’s own version', async () => {
  const app = await startApp({ env: on });
  try {
    await app.login('admin');
    await accept(app, 'admin');
    await app.call('admin', 'PATCH', '/api/admin/settings', { legalController: 'Beispiel-Hochschule, Campusweg 1, 12345 Stadt', legalDpo: 'Dr. Daten, datenschutz@beispiel.test', legalContact: 'datenschutz@beispiel.test', legalAuthority: 'Landesbeauftragter für den Datenschutz', lectureTextRetentionDays: 90 });
    await app.register('prof');
    app.db.run("UPDATE users SET role = 'lecturer' WHERE email = 'prof@test.invalid'");
    await accept(app, 'prof');
    const lecturer = (await get(app, 'prof')).body;
    assert.equal(lecturer.roleLabel, 'Dozierende');
    assert.match(lecturer.markdown, /Verantwortlicher \| Beispiel-Hochschule, Campusweg 1, 12345 Stadt/);
    assert.match(lecturer.markdown, /datenschutz@beispiel\.test/);
    assert.match(lecturer.markdown, /Landesbeauftragter für den Datenschutz/);
    assert.match(lecturer.markdown, /\| 90 Tage nach ihrer Entstehung/);
    assert.match((await get(app, 'prof', '?lang=en')).body.markdown, /Controller \| Beispiel-Hochschule, Campusweg 1, 12345 Stadt/);

    await app.register('stu');
    await accept(app, 'stu');
    const student = (await get(app, 'stu')).body;
    assert.equal(student.roleLabel, 'Studierende');
    assert.doesNotMatch(student.markdown, /Anhang III/);
    assert.equal((await app.call('stu', 'PATCH', '/api/admin/settings', { legalController: 'Me' })).status, 403, 'only administrators set the details');
  } finally {
    await app.close();
  }
});

test('without details entered the text says so in its own language, never as a blank', () => {
  assert.match(agreementFor({ role: 'student', lang: 'en', institution: 'Example University' }).markdown, /data-protection officer of your institution/);
  assert.match(agreementFor({ role: 'student', lang: 'de', institution: 'Beispiel-Hochschule' }).markdown, /Verantwortlicher \| Beispiel-Hochschule/);
  assert.match(agreementFor({ role: 'student', lang: 'de' }).markdown, /Verantwortlicher \| Ihre Einrichtung/);
});
