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
    sources: [
      { title: 'Stundenplan Bachelor Digital Technology and Management', url: 'https://example.invalid/DTM.pdf', kind: 'timetable', programme: 'DTM', timetables: 2 },
      { title: 'Prüfungsplan Bachelor Digital Technology and Management', url: 'https://example.invalid/DTM-exams.pdf', kind: 'exam-plan', programme: 'DTM', term: 'SoSe 2026', timetables: 0 },
      { title: 'Stundenplan Bachelor Elektro', url: 'https://example.invalid/Studiengaenge/Bachelor/EI/x.pdf', kind: 'timetable', programme: 'EI', timetables: 0 },
      { title: 'Timetable Bachelor International Business', url: 'https://example.invalid/IB/Stundenplan_IB.pdf', kind: 'module-handbook', programme: 'IB', timetables: 0 },
    ],
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
  assert.match(picture, /a picture or a format I cannot read \(https:\/\/example\.invalid\/Studiengaenge/, 'a programme that publishes an image says so and links it');

  // "an IB student": the file the university links as IB's timetable is its module handbook, and the answer says so.
  const ib = t.describe({ codes: ['IB'], now: monday }).join('\n');
  assert.match(ib, /does not publish a weekly timetable/);
  assert.match(ib, /module handbook \(https:\/\/example\.invalid\/IB\/Stundenplan_IB\.pdf\)/);
  assert.match(ib, /Never invent lessons/);

  // Tomorrow and the day after are listed with their dates; the exam plan link comes with the timetable.
  assert.match(unknown, /DTM tomorrow \(Tue 10 Nov\): no classes/);
  assert.match(unknown, /DTM the day after tomorrow \(Wed 11 Nov\): no classes/);
  assert.match(unknown, /DTM exam plan \(SoSe 2026\): https:\/\/example\.invalid\/DTM-exams\.pdf/);
  const friday = t.describe({ codes: ['DTM'], semester: 1, now: new Date('2026-11-12T18:00:00+01:00') }).join('\n');
  assert.match(friday, /DTM tomorrow \(Fri 13 Nov\): no classes/);
  const sundayNight = t.describe({ codes: ['DTM'], semester: 1, now: new Date('2026-11-08T21:00:00+01:00') }).join('\n');
  assert.match(sundayNight, /DTM tomorrow \(Mon 9 Nov\): DTM sem 1: 08:15–11:30 IoT Technology/);
  assert.match(sundayNight, /DTM sem 1 week:|DTM semester 1 week: Mon:/);

  // Spoken forms: lower case, and the programme named last is the one meant.
  assert.deepEqual(t.mentioned('what does an ib student have tomorrow? oh i do dtm. what do i have tomorrow?'), ['DTM', 'IB']);
  assert.deepEqual(t.mentioned('i study dtm'), ['DTM']);
  assert.deepEqual(t.mentioned('i am in ib'), ['IB']);
  assert.deepEqual(t.mentioned('tell me about the mensa, it is in the new building'), [], 'ordinary words are not programmes');
  assert.deepEqual(t.mentioned('ich bin im dtm'), ['DTM']);
  assert.equal(t.semesterIn('semester 3... no wait, semester 5'), 5, 'the last one said wins');

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

test('exam plans: what is still to come, and what the last semester looked like', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campusos-ex-'));
  const row = (date, term, module, extra = {}) => ({ programme: 'DTM', faculty: null, term, date, start: '09:00', end: '10:30', module, text: `${module} · Examiner · HS 140`, source: `https://example.invalid/${term.replace(' ', '')}.pdf`, label: 'Prüfungsplan DTM', ...extra });
  fs.writeFileSync(path.join(dir, 'ex.json'), JSON.stringify({ exams: [
    row('2026-07-03', 'SoSe 2026', 'Object-oriented Coding'),
    row('2026-07-06', 'SoSe 2026', 'Business Processes'),
    row(null, 'SoSe 2026', 'Robotik'),
    row('2027-01-20', 'WS 2026/27', 'Mathematics'),
    row('2027-01-25', 'WS 2026/27', 'IoT Technology'),
    row('2026-07-10', 'SoSe 2026', 'Cooking', { programme: 'ZZ' }),
  ] }));
  const { createExams } = require('../src/ai/exams');
  const exams = createExams({ root: dir, file: 'ex.json', timeZone: 'Europe/Berlin' });
  const now = new Date('2026-11-09T10:00:00+01:00');

  assert.equal(exams.wantsExams('when is my exam?'), true);
  assert.equal(exams.wantsExams('wann ist die Klausur'), true);
  assert.equal(exams.wantsExams('what lecture do I have'), false);
  assert.equal(exams.wantsLast('what was the exam schedule like last semester?'), true);
  assert.equal(exams.wantsLast('wie war der Prüfungsplan im letzten Semester'), true);

  const ahead = exams.describe({ codes: ['DTM'], text: 'when are my exams', now }).join('\n');
  assert.match(ahead, /exams still to come \(from 2026-11-09\)/);
  assert.match(ahead, /2027-01-20 09:00–10:30 · Mathematics/);
  assert.ok(ahead.indexOf('Mathematics') < ahead.indexOf('IoT Technology'), 'in date order');
  assert.ok(!/Object-oriented Coding/.test(ahead), 'last semester is not listed unless asked for');
  assert.ok(!/Cooking/.test(ahead), 'another programme\'s exams are not mixed in');

  const last = exams.describe({ codes: ['DTM'], text: 'what was the exam schedule like last semester?', now }).join('\n');
  assert.match(last, /exams of SoSe 2026 \(the last finished term\)/);
  assert.match(last, /2026-07-03 09:00–10:30 · Object-oriented Coding/);
  assert.match(last, /without a fixed date[^\n]*Robotik/);
  assert.match(last, /terms covered: WS 2026\/27, SoSe 2026/);

  const none = exams.describe({ codes: ['QQ'], text: 'exam', now }).join('\n');
  assert.match(none, /no exam plan for this programme/);
});

test('the assistant can be asked to open one of the university\'s pages, and nothing else', async () => {
  let reply = '';
  const app = await startApp({
    env: { AI_GATEWAY_API_KEY: 'fixture-key' },
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
    env: { AI_GATEWAY_API_KEY: 'fixture-key' },
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
    assert.match(first, /DTM tomorrow \(\w{3} \d+ \w{3}\):/, 'DTM, said last, is the programme and tomorrow has a date');
    assert.match(first, /IB \(.*does not publish a weekly timetable.*module handbook \(https:\/\/www\.oth-aw\.de\/files\//, 'IB has no timetable and the answer says so with the file it does have');
    assert.ok(first.indexOf('Official timetable for DTM') < first.indexOf('IB ('), 'the programme named last comes first');
    assert.match(first, /LANGUAGE|Languages: this is a bilingual/);
    assert.match(first, /Links: never paste a long web address/);
    assert.match(first, /link\.open/);

    const exams = await system('what was the exam schedule like last semester? i do dtm');
    assert.match(exams, /DTM exams of SoSe 2026 \(the last finished term\)/);
    assert.match(exams, /Object-oriented Coding/);
    assert.match(exams, /DTM exam plans in the data: SoSe 2026: https:\/\/www\.oth-aw\.de\/files\//);

    const plain = await system('i do dtm. what lecture do i have today?');
    assert.ok(!/exams of SoSe 2026/.test(plain), 'exam rows are only added when exams are asked about');
  } finally {
    await app.close();
  }
});
