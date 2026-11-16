'use strict';
/**
 * What the assistant knows about the university itself: search across German and English, the published class
 * timetables ("what lecture do I have right now?"), the bundled website packs, and the campus map.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startApp } = require('./helpers');
const { buildIndex, search } = require('../src/lib/search');
const { createRetrieval } = require('../src/ai/retrieval');
const { assistantPrompt } = require('../src/ai/prompts');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);

const DOCS = [
  { id: 1, title: 'Bahnhof Weiden', content: 'Der Bahnhof Weiden liegt westlich der Stadt. Buslinie 3 fährt zum Hetzenrichter Weg.' },
  { id: 2, title: 'Mentoring programme', content: 'The mentoring programme matches first-year students with senior students.' },
  { id: 3, title: 'Kontakt Studiengangsleiter', content: 'Studiengangsleiter Digital Technology and Management, E-Mail leiter@example.invalid, Raum 1.15' },
  { id: 4, title: 'Mensa', content: 'Mittagessen in der Mensa von 11 bis 14 Uhr.' },
];

test('search finds German pages from English questions, and survives spelling mistakes', () => {
  const index = buildIndex(DOCS);
  const top = (q) => search(index, q, { limit: 1, minScore: 0 })[0]?.title;
  assert.equal(top('how do I get to Banhof'), 'Bahnhof Weiden', 'a slipped letter still finds the station');
  assert.equal(top('what is the mentor'), 'Mentoring programme');
  assert.equal(top('contact of the director of Digital Technology and Management'), 'Kontakt Studiengangsleiter', 'English words reach the German page');
  assert.equal(top('where is the canteen'), 'Mensa');
  assert.equal(top('Studiengangleiter'), 'Kontakt Studiengangsleiter', 'a missing letter in a long German word still matches');
});

test('the assistant sees the timetable of the programme the user names, and only that programme', async () => {
  const seen = [];
  const app = await startApp({
    env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_BUNDLED_KNOWLEDGE: 'on' },
    fetchImpl: async (url, options) => {
      seen.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Okay.' } }] }));
    },
  });
  try {
    await app.login('admin');
    await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
    await app.register('stu');

    await app.call('stu', 'POST', '/api/assistant/messages', { prompt: "I'm in DTM, welche Vorlesung habe ich gerade?" });
    const named = seen.at(-1).messages[0].content;
    assert.ok(named.endsWith('</SOURCES>'), 'the provider receives complete reference boundaries, not a truncated page');
    assert.match(named, /Programme: DTM/);
    assert.match(named, /S077/);
    assert.ok(!/Programme: DHM/.test(named));

    await app.call('stu', 'PUT', '/api/me/profile', { programme: 'Digital Healthcare Management', semester: 1, interests: [] });
    await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'what do I have today?' });
    const own = seen.at(-1).messages[0].content;
    assert.match(own, /Programme: DHM/, 'the programme in the profile is used without being said');

    await app.register('plain');
    await app.call('plain', 'POST', '/api/assistant/messages', { prompt: 'hello' });
    assert.match(seen.at(-1).messages[0].content, /offline academic snapshot/, 'with no programme known it lists the codes so it can ask once');
  } finally {
    await app.close();
  }
});

test('the prompt prepares the assistant for mixed German and English', () => {
  const system = assistantPrompt({ site: {}, user: { name: 'Ana K', role: 'student', institution: 'OTH' }, assistantName: 'Citrus', context: 'x', sources: [] });
  assert.match(system, /German and English together/);
  assert.match(system, /Banhof/);
  assert.match(system, /Schirmitzer Weg/);
  assert.match(system, /halb drei/);
});

test('bundled packs are searched together with the library, without importing anything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campusos-pack-'));
  const file = path.join(dir, 'pack.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ id: 'a', title: 'Studienbüro Kontakt', content: 'Das Studienbüro Weiden: studienbuero@example.invalid, Telefon +49 961 0000', category: 'Website', sources: [{ url: 'https://example.invalid/sb' }], tags: ['de'] })}\nnot json\n`);
  const db = { get: () => ({ n: 0, maxId: null, changed: null }), all: () => [] };
  const retrieval = createRetrieval(db, { packs: [file, path.join(dir, 'missing.jsonl')] });
  assert.equal(retrieval.bundledCount(), 1);
  const [hit] = retrieval.find(1, 'contact details of the study office');
  assert.equal(hit.title, 'Studienbüro Kontakt');
  assert.equal(hit.source_url, 'https://example.invalid/sb');
  assert.ok(hit.id < 0, 'bundled entries never collide with database rows');
});

test('the campus map is served to signed-in users and lists the upcoming lessons with rooms', async () => {
  const app = await startApp({ env: { CAMPUS_BUNDLED_KNOWLEDGE: 'on' } });
  try {
    await app.register('stu');
    assert.equal((await app.call('anon', 'GET', '/api/campus/map')).status, 401);
    assert.equal((await app.call('anon', 'GET', '/api/campus/map/classes')).status, 401);

    const map = (await app.call('stu', 'GET', '/api/campus/map')).body.map;
    assert.deepEqual(map.campuses.map((c) => c.id), ['weiden', 'amberg']);
    assert.match(map.attribution, /OpenStreetMap/);
    assert.ok(map.campuses.every((c) => c.buildings.length > 50 && c.places.length >= 5));

    const day = new Date(Date.now() + 86_400_000);
    day.setHours(10, 0, 0, 0);
    const end = new Date(day.getTime() + 3_600_000);
    await app.call('stu', 'POST', '/api/timetable', { title: 'Study group', kind: 'personal', location: 'WTC 1.25', starts: day.toISOString(), ends: end.toISOString() });
    const res = (await app.call('stu', 'GET', '/api/campus/map/classes?programme=DTM&semester=1')).body;
    assert.ok(res.classes.some((c) => c.source === 'schedule' && c.location === 'WTC 1.25'));
    assert.ok(!res.classes.some((c) => c.source === 'official'), 'unverified layout data is never treated as calendar events');
    assert.ok(res.programmes.some((p) => p.code === 'DTM'));
    assert.equal((await app.call('stu', 'GET', '/api/campus')).body.hasMap, true);
    assert.equal((await app.call('anon', 'GET', '/api/bootstrap')).body.site.map, true);

    await app.register('other');
    const mine = (await app.call('other', 'GET', '/api/campus/map/classes')).body.classes;
    assert.ok(!mine.some((c) => c.title === 'Study group'), 'one student never sees another student\'s schedule');
  } finally {
    await app.close();
  }
});

test('a room finds its building on the map, and unknown buildings are said to be unknown', async () => {
  const { resolvePlace, distanceMetres, walkMinutes, directionsLinks, nearestCampus } = await load('features/campus-places.js');
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'oth-campus-map.json'), 'utf8'));
  const at = (text, prefer) => {
    const r = resolvePlace(map, text, prefer);
    return r?.place ? `${r.campus.id}:${r.place.id}` : r?.unmapped ? `${r.campus.id}:unmapped:${r.unmapped.name}` : null;
  };
  assert.equal(at('HSG 001'), 'weiden:hsg');
  assert.equal(at('WTC 1.25'), 'weiden:wtc');
  assert.equal(at('EMI104'), 'amberg:emi');
  assert.equal(at('Hörsaalgebäude (H001)'), 'weiden:hsg');
  assert.equal(at('EH 4.4'), 'weiden:unmapped:E-House', 'the E-House is not in the map data, and the page says so');
  assert.equal(at('Bibliothek', 'amberg'), 'amberg:library', 'a code that exists on both campuses follows the campus in view');
  assert.equal(at('Bibliothek Weiden', 'amberg'), 'weiden:library', 'a campus named in the text wins');
  assert.equal(at('240'), null, 'a bare room number says nothing about the building');
  assert.equal(at('HSGX 4'), null, 'letters around a code do not count as the code');

  const here = { lat: 49.6685, lon: 12.1798 };
  const hsg = map.campuses[0].places.find((p) => p.id === 'hsg');
  const m = distanceMetres(here, hsg);
  assert.ok(m > 200 && m < 400);
  assert.ok(walkMinutes(m) >= 3 && walkMinutes(m) <= 6);
  assert.match(directionsLinks(here, hsg).osm, /openstreetmap\.org\/directions.*49\.6685%2C12\.1798/);
  assert.match(directionsLinks(null, hsg).google, /destination=49\.\d+,12\.\d+/);
  assert.equal(nearestCampus(map, here).campus.id, 'weiden');
  assert.equal(nearestCampus(map, { lat: 49.4449, lon: 11.8474 }).campus.id, 'amberg');
});

test('the assistant can be asked to open one of the university\'s pages, and nothing else', async () => {
  let reply = '';
  const app = await startApp({
    env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_BUNDLED_KNOWLEDGE: 'on' },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: reply } }] })),
  });
  try {
    await app.login('admin');
    await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
    await app.register('stu');
    const open = async (url) => {
      reply = `[action: link.open | {"url":${JSON.stringify(url)},"title":"Exam plan DTM (PDF)"}]\n\nÖffne es.`;
      return (await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'open it' })).body.message.actions[0];
    };

    const ok = await open('https://www.oth-aw.de/files/oth-aw/Studiengaenge/Bachelor/DTM/Dokumente/finaler_Pruefungsplan_Studiengang_DTM.pdf');
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.client.type, 'open');
    assert.match(ok.client.url, /^https:\/\/www\.oth-aw\.de\/files\//);
    assert.equal(ok.detail, 'Exam plan DTM (PDF)');
    assert.match(ok.link, /^https:\/\/www\.oth-aw\.de/);
    assert.equal((await open('https://moodle.oth-aw.de/course/view.php?id=1')).ok, true, 'a subdomain of the university');

    for (const bad of ['http://www.oth-aw.de/x', 'https://oth-aw.de.evil.example/x', 'https://evil.example/oth-aw.de', 'https://user:pw@www.oth-aw.de/x', 'javascript:alert(1)', 'not a url', '']) {
      const refused = await open(bad);
      assert.equal(refused.ok, false, bad);
      assert.equal(refused.client, undefined);
    }
  } finally {
    await app.close();
  }
});

test('out of the blue: the utterance alone is enough to get the right programme, tomorrow, exams and the links', async () => {
  const seen = [];
  const app = await startApp({
    env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_BUNDLED_KNOWLEDGE: 'on' },
    fetchImpl: async (url, options) => {
      seen.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Okay.' } }] }));
    },
  });
  try {
    await app.login('admin');
    await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
    await app.register('stu'); // no programme in the profile
    const system = async (prompt) => {
      await app.call('stu', 'POST', '/api/assistant/messages', { prompt });
      return seen.at(-1).messages[0].content;
    };

    const first = await system('what is an ib student going to have tomorrow? oh i do dtm. what do i have tomorrow?');
    assert.match(first, /Programme: DTM, IB/);
    assert.match(first, /S077/);
    assert.doesNotMatch(first, /does not publish a weekly timetable/);
    assert.match(first, /LANGUAGE|Languages: this is a bilingual/);
    assert.match(first, /Links: never paste a long web address/);
    assert.match(first, /link\.open/);

    const exams = await system('what was the exam schedule like last semester? i do dtm');
    assert.match(exams, /S078/);
    assert.match(exams, /SS 2026/);
    assert.match(exams, /Object.oriented Coding/);
    assert.match(exams, /finaler_Pruefungsplan_Studiengang_DTM/);

    const plain = await system('i do dtm. what lecture do i have today?');
    assert.ok(!/exams of SoSe 2026/.test(plain), 'exam rows are only added when exams are asked about');
  } finally {
    await app.close();
  }
});
