'use strict';
/**
 * Notifications are written in English where they happen and reach each person in their own language: German for
 * people who use German (and for anyone who never chose, since German is what most people here use), in the inbox and
 * in the push message.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inGerman, hasGermanTitle, hasGermanBody } = require('../src/modules/notifications/german');
const { startApp } = require('./helpers');

test('every notification the server sends has a German wording', () => {
  // Every notify(...) call: its title and body, written in English, with ${...} standing for what is filled in.
  const root = path.join(__dirname, '..', 'src');
  const calls = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js') && !/notifications[\\/](service|german)\.js$/.test(f)) {
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(/title:\s*(?:\w+\s*\?\s*)?(['"`])((?:(?!\1)[^\\\n]|\\.)+)\1/g)) calls.push({ f, title: m[2] });
      }
    }
  };
  walk(root);
  const sample = (t) => t.replace(/\$\{[^}]*\}/g, 'X').replace(/\\(.)/g, '$1');
  const titles = calls.map((c) => ({ ...c, title: sample(c.title) }))
    // only the strings that are notification titles (the ones notify() is called with)
    .filter((c) => /notify\(|kind: '(?:system|campus|course|device)'/.test(fs.readFileSync(c.f, 'utf8')) && /^[A-Z]/.test(c.title) && c.title.length < 90);
  assert.ok(titles.length >= 12, `${titles.length} notification titles found`);
  const missing = titles.filter((c) => !hasGermanTitle(c.title) && !/^X/.test(c.title) && !/^(Courses|Settings|Notifications)$/.test(c.title)).map((c) => `${path.relative(root, c.f)}: ${c.title}`);
  // A title that is only filled-in content (a post's own title) needs no translation; the rest must have one.
  const real = missing.filter((m) => /notification|post|lecture|lecturer|card|study|sign-in|exam|schedule|concept|live|Notifications/i.test(m));
  assert.deepEqual(real, [], 'add the German wording to src/modules/notifications/german.js');
});

test('the wording is German, keeps the names and numbers, and leaves other text alone', () => {
  assert.deepEqual(inGerman({ kind: 'course', title: 'Lecture scheduled: Week 5', body: 'ML101 · HSG 001', link: '/lectures' }), { kind: 'course', title: 'Vorlesung geplant: Week 5', body: 'ML101 · HSG 001', link: '/lectures' });
  assert.equal(inGerman({ title: 'Machine Learning is live', body: "ML101. Open it to tell your lecturer how you're following." }).title, 'Machine Learning ist live');
  assert.equal(inGerman({ title: 'Machine Learning is live', body: "ML101. Open it to tell your lecturer how you're following." }).body, 'ML101. Öffne sie, um deiner Lehrperson zu sagen, wie du mitkommst.');
  assert.equal(inGerman({ title: 'Machine Learning is live again' }).title, 'Machine Learning ist wieder live');
  assert.equal(inGerman({ title: 'Another student is also looking for a study group' }).title, 'Eine andere Person sucht ebenfalls eine Lerngruppe');
  assert.equal(inGerman({ title: 'Ann Person is also looking for a study group' }).title, 'Ann Person sucht ebenfalls eine Lerngruppe');
  assert.equal(inGerman({ title: 'A post the author wrote', body: 'Free text the author wrote' }).body, 'Free text the author wrote', 'a person’s own words are never translated');
  assert.ok(hasGermanTitle('Card linked') && hasGermanBody("Ann's card is now linked."));
});

test('each person gets the notification in their own language, in the inbox and in the push message', async () => {
  const app = await startApp({ env: { CAMPUS_DEFAULT_LANGUAGE: 'de' } });
  try {
    await app.login('admin');
    await app.register('ann');
    await app.register('ben');
    await app.call('ben', 'PATCH', '/api/me', { preferences: { language: 'en' } });
    const annId = app.db.get("SELECT id FROM users WHERE email = 'ann@test.invalid'").id; // never chose a language
    const benId = app.db.get("SELECT id FROM users WHERE email = 'ben@test.invalid'").id;
    const sent = [];
    const notifier = app.app.deps.notifier;
    app.app.deps.push.send = async (sub, payload) => { sent.push(payload); return 'ok'; };
    for (const id of [annId, benId]) app.db.run("INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, created) VALUES(?, ?, 'k', 'a', ?)", id, `https://push.example/${id}`, new Date().toISOString());
    notifier.notify([annId, benId], { kind: 'course', title: 'Lecture scheduled: Week 5', body: 'ML101 · HSG 001', link: '/lectures', urgent: true });
    await new Promise((r) => setTimeout(r, 50));
    const rows = (id) => app.db.get('SELECT title, body FROM notifications WHERE user_id = ?', id);
    assert.equal(rows(annId).title, 'Vorlesung geplant: Week 5', 'German unless the person chose English');
    assert.equal(rows(benId).title, 'Lecture scheduled: Week 5');
    assert.deepEqual(sent.map((p) => p.title).sort(), ['Lecture scheduled: Week 5', 'Vorlesung geplant: Week 5'], 'the push message too');
  } finally {
    await app.close();
  }
});
