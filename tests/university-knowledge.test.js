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
const { createProgrammeTimetables } = require('../src/ai/programme-timetables');
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

test('the published class timetable answers "what do I have right now" for any programme named in the conversation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campusos-tt-'));
  fs.writeFileSync(path.join(dir, 'tt.json'), JSON.stringify({
    sources: [{ title: 'Stundenplan Bachelor Digital Technology and Management', url: 'https://example.invalid/DTM.pdf', timetables: 2 }, { title: 'Stundenplan Bachelor Elektro', url: 'https://example.invalid/Studiengaenge/Bachelor/EI/x.pdf', timetables: 0 }],
    classes: [
      { programme: 'DTM', programmeName: 'Bachelor Digital Technology and Management', level: 'BA', semester: 1, label: 'DTM 1', stand: '01.10.2026', validFrom: '01.10.2026', source: 'https://example.invalid/DTM.pdf', events: [
        { day: 0, start: '08:15', end: '11:30', text: 'IoT Technology · HSG 001 · Dalm', lines: ['IoT Technology', 'HSG 001', 'Dalm'], format: 'in person' },
        { day: 0, start: '12:15', end: '15:30', text: 'GE 1 · EH 4.4 · Prucha', lines: ['GE 1', 'EH 4.4', 'Prucha'], format: 'in person' },
      ] },
      { programme: 'DTM', programmeName: 'Bachelor Digital Technology and Management', level: 'BA', semester: 3, label: 'DTM 3', source: 'https://example.invalid/DTM.pdf', events: [
        { day: 0, start: '08:15', end: '09:45', text: 'Sensors · WTC 1.25 · Erzberger', lines: ['Sensors', 'WTC 1.25', 'Erzberger'], format: 'in person' },
      ] },
    ],
  }));
  const t = createProgrammeTimetables({ root: dir, file: 'tt.json', timeZone: 'Europe/Berlin' });

  assert.deepEqual(t.mentioned("I'm in DTM, was habe ich jetzt?"), ['DTM']);
  assert.deepEqual(t.mentioned('Digital Technology and Management'), ['DTM'], 'a programme can be named in full');
  assert.deepEqual(t.mentioned('ich habe ein ok von WS und SS'), [], 'level and term words are not programmes');
  assert.deepEqual(t.fromProfile('dtm'), ['DTM']);
  assert.equal(t.semesterIn('im 3. Semester'), 3);
  assert.equal(t.semesterIn('semester 5'), 5);

  const monday = new Date('2026-11-09T09:30:00+01:00');
  const sem1 = t.describe({ codes: ['DTM'], semester: 1, now: monday }).join('\n');
  assert.match(sem1, /DTM right now \(Mon 09:30\): DTM sem 1: 08:15–11:30 IoT Technology · HSG 001 · Dalm/);
  assert.match(sem1, /later today: DTM sem 1: 12:15–15:30 GE 1/);
  assert.ok(!/Sensors/.test(sem1), 'another semester is not shown once the semester is known');

  const unknown = t.describe({ codes: ['DTM'], now: monday }).join('\n');
  assert.match(unknown, /DTM sem 1: 08:15–11:30 IoT Technology/);
  assert.match(unknown, /DTM sem 3: 08:15–09:45 Sensors/, 'without a semester every class with something on is listed');

  const sunday = t.describe({ codes: ['DTM'], semester: 1, now: new Date('2026-11-08T14:00:00+01:00') }).join('\n');
  assert.match(sunday, /no class is running/);

  const picture = t.describe({ codes: ['EI'], now: monday }).join('\n');
  assert.match(picture, /only as a picture or PDF/, 'a programme that publishes an image says so and links it');

  const next = t.upcoming({ codes: ['DTM'], semester: 1, now: monday, days: 2 });
  assert.equal(next[0].location, 'HSG 001');
  assert.equal(next[0].source, 'official');
  assert.ok(Date.parse(next[0].starts) < Date.parse(next[1].starts));
});

test('the assistant sees the timetable of the programme the user names, and only that programme', async () => {
  const seen = [];
  const app = await startApp({
    env: { AI_GATEWAY_API_KEY: 'fixture-key' },
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
    assert.match(named, /Official timetable for DTM/);
    assert.match(named, /DTM right now/);
    assert.ok(!/Official timetable for DHM/.test(named));

    await app.call('stu', 'PUT', '/api/me/profile', { programme: 'Digital Healthcare Management', semester: 1, interests: [] });
    await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'what do I have today?' });
    const own = seen.at(-1).messages[0].content;
    assert.match(own, /Official timetable for DHM/, 'the programme in the profile is used without being said');

    await app.register('plain');
    await app.call('plain', 'POST', '/api/assistant/messages', { prompt: 'hello' });
    assert.match(seen.at(-1).messages[0].content, /exist for these programme codes/, 'with no programme known it lists the codes so it can ask once');
  } finally {
    await app.close();
  }
});

test('the prompt prepares the assistant for mixed German and English', () => {
  const system = assistantPrompt({ site: {}, user: { name: 'Ana K', role: 'student', institution: 'OTH' }, assistantName: 'Campus', context: 'x', sources: [] });
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
  const app = await startApp();
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
    assert.ok(res.classes.some((c) => c.source === 'official' && c.programme === 'DTM'));
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
