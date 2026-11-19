'use strict';
/**
 * The assistant knows Citrus and can use most of it for the person: what it is told about the features (from the same
 * registry as All tools, for the person's role), what it can do (the study sign, joining a lecture, a lecturer's break and
 * chapters, more pages to open), and that German and English both reach the right feature.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startApp } = require('./helpers');
const { featureGuide, featureLines, firstSentence } = require('../src/ai/features');
const { assistantPrompt } = require('../src/ai/prompts');
const design = require('../src/modules/sign/design');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);

// ---- what the assistant is told ------------------------------------------------------------------------------

test('the assistant is told the features of Citrus for the role it is talking to, honestly', () => {
  const student = featureGuide('student');
  assert.match(student, /WHAT CITRUS CAN DO/);
  assert.match(student, /- Study sign \[\/sign\]/, 'the newest feature is there without anyone adding it by hand');
  assert.match(student, /- Live lecture/);
  assert.doesNotMatch(student, /Lecturer approvals/, 'a student is not told about administration');
  assert.match(featureGuide('admin'), /Lecturer approvals \[\/admin\/people\]/);
  assert.match(featureGuide('lecturer'), /Breaks, chapters and recording edits/);

  // A feature that is not built is described as not built.
  const groups = [{ group: 'x', items: [{ id: 'a', label: 'Flying desks', status: 'planned', route: null, description: 'Desks that fly. And more.' }, { id: 'b', label: 'Setup thing', status: 'configuration', route: '/x', description: 'Needs a key.' }] }];
  const lines = featureLines('student', groups);
  assert.equal(lines[0], '- Flying desks (IN DEVELOPMENT: not built yet): Desks that fly.');
  assert.match(lines[1], /needs set-up by the university/);
  assert.equal(firstSentence('One. Two.'), 'One.');
  assert.ok(firstSentence('x'.repeat(400)).length <= 170);
  assert.match(featureGuide('student'), /Vorlesungen.*Lernschild/s, 'the German names of the pages are in it');

  // Another university's people are not offered features that are about OTH.
  const elsewhere = featureGuide('student', undefined, { university: 'Example University' });
  assert.doesNotMatch(elsewhere, /Amberg|OTH/);
  assert.match(elsewhere, /- Study sign \[\/sign\]/, 'but they still get the rest');
  assert.match(featureGuide('student', undefined, { university: 'OTH Amberg-Weiden — Independent Concept' }), /University website knowledge/);
});

test('the main prompt carries the feature list, the new actions and the language rule for them', () => {
  const prompt = assistantPrompt({ site: { concept: false }, user: { name: 'Ann Student', role: 'student', institution: 'OTH' }, assistantName: 'Citrus', context: '', sources: [] });
  assert.match(prompt, /WHAT CITRUS CAN DO/);
  for (const name of ['sign.show', 'lecture.join', 'lecture.break', 'lecture.resume', 'lecture.chapter']) assert.ok(prompt.includes(name), name);
  assert.match(prompt, /lectures\|meetings\|library\|apps\|sign/, 'the pages it can open');
  assert.match(prompt, /Action lines are always written exactly as shown, in English/, 'German answers keep the action syntax');
  assert.match(prompt, /Answer in the language|Reply in the language of the latest message/);
});

// ---- what the assistant can do -------------------------------------------------------------------------------

function gateway(reply) {
  const state = { last: null };
  return {
    state,
    async fetchImpl(url, options) {
      state.last = JSON.parse(options.body);
      const text = reply(state.last.messages.at(-1).content);
      if (state.last.stream) {
        const chunks = text.match(/[\s\S]{1,7}/g).map((part) => `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
        return new Response(`${chunks.join('')}data: [DONE]\n\n`);
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
    },
  };
}
const parseSse = (text) => text.split('\n\n').filter(Boolean).map((chunk) => ({ event: /event: (.+)/.exec(chunk)?.[1], data: JSON.parse(/data: (.+)/.exec(chunk)?.[1] || 'null') }));
async function ask(app, who, prompt) {
  const res = await app.call(who, 'POST', '/api/assistant/messages', { prompt }, { headers: { accept: 'text/event-stream' }, raw: true });
  assert.equal(res.status, 200);
  const events = parseSse(await res.text());
  return { actions: events.filter((e) => e.event === 'action').map((e) => e.data) };
}

async function setup(actionLine) {
  const fixture = gateway(() => actionLine);
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: fixture.fetchImpl });
  await app.login('admin');
  const lecturerId = await app.lecturer('prof');
  await app.lecturer('other');
  const course = await app.call('admin', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' });
  await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
  await app.register('ann');
  await app.call('ann', 'POST', `/api/courses/${course.body.id}/enroll`);
  return { app, fixture, courseId: course.body.id, set: (line) => { actionLine = line; } };
}

test('"show a do not disturb sign": the assistant opens the study sign, safe whatever it is asked for', async () => {
  const { app, set } = await setup('');
  try {
    set('[action: sign.show | {"style":"flash-red","language":"de","message":"Prüfung morgen – bitte leise","symbol":"book"}]\n\nZeige das Schild.');
    const made = (await ask(app, 'ann', 'Zeig ein rotes blinkendes Schild auf Deutsch')).actions[0];
    assert.equal(made.ok, true);
    assert.equal(made.client.type, 'navigate');
    assert.match(made.client.path, /^\/sign\?show=1&spec=[A-Za-z0-9_-]+$/);
    const { decodeSpec } = await load('features/sign-model.js');
    const spec = decodeSpec(new URL(made.client.path, 'http://x').searchParams.get('spec'));
    assert.deepEqual([spec.style, spec.language, spec.message, spec.symbol], ['flash', 'de', 'Prüfung morgen – bitte leise', 'book'], 'umlauts survive the link');
    assert.equal(spec.speed, 'slow', 'a flashing sign is a slow pulse');
    assert.deepEqual(spec, design.specFromArgs({ style: 'flash-red', language: 'de', message: 'Prüfung morgen – bitte leise', symbol: 'book' }), 'the page and the server agree');

    // Nothing is needed: a plain black sign in the person's own language.
    set('[action: sign.show | {}]\n\nShowing it.');
    const plain = (await ask(app, 'ann', 'show a do not disturb sign')).actions[0];
    const plainSpec = decodeSpec(new URL(plain.client.path, 'http://x').searchParams.get('spec'));
    assert.deepEqual([plainSpec.style, plainSpec.background, plainSpec.color, plainSpec.language], ['solid', '#000000', '#ffffff', 'en']);

    // Unreadable or hostile values are repaired, not obeyed.
    set('[action: sign.show | {"background":"#ffffff","color":"#fefefe","style":"strobe","size":"huge","message":"<script>alert(1)</script>"}]\n\nOk.');
    const odd = decodeSpec(new URL((await ask(app, 'ann', 'a sign')).actions[0].client.path, 'http://x').searchParams.get('spec'));
    assert.equal(odd.color, '#000000');
    assert.deepEqual([odd.style, odd.size], ['solid', 'l']);
    assert.equal(decodeSpec('not base64 at all !!!'), null);
  } finally {
    await app.close();
  }
});

test('"join the lecture with code 482 913": students only, and the code must be six digits', async () => {
  const { app, set } = await setup('');
  try {
    set('[action: lecture.join | {"code":"482 913"}]\n\nJoining.');
    const joined = (await ask(app, 'ann', 'join lecture 482 913')).actions[0];
    assert.deepEqual([joined.ok, joined.client.path], [true, '/join/482913']);
    set('[action: lecture.join | {"code":"4829"}]\n\nJoining.');
    const bad = (await ask(app, 'ann', 'join 4829')).actions[0];
    assert.equal(bad.ok, false);
    assert.match(bad.error, /six digits/);
    set('[action: lecture.join | {"code":"482913"}]\n\nJoining.');
    assert.equal((await ask(app, 'prof', 'join 482913')).actions[0].ok, false, 'a lecturer does not join');
  } finally {
    await app.close();
  }
});

test('a lecturer takes a break and marks a chapter by asking; nobody else can', async () => {
  const { app, courseId, set } = await setup('');
  try {
    set('[action: lecture.break | {}]\n\nPause.');
    const none = (await ask(app, 'prof', 'machen wir Pause')).actions[0];
    assert.equal(none.ok, false);
    assert.match(none.error, /no live lecture/);

    const sid = (await app.call('prof', 'POST', '/api/live/sessions', { course_id: courseId, title: 'Week 5' })).body.session.id;
    const first = (await ask(app, 'prof', 'machen wir Pause')).actions[0];
    assert.deepEqual([first.ok, first.title], [true, 'Break started']);
    assert.ok(app.db.get('SELECT paused_at FROM live_sessions WHERE id = ?', sid).paused_at);
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/signal`, { level: 2 })).status, 409, 'the class cannot answer during it');
    assert.equal((await ask(app, 'prof', 'machen wir Pause')).actions[0].title, 'The lecture is already on a break');

    set('[action: lecture.resume | {}]\n\nWeiter.');
    assert.equal((await ask(app, 'prof', 'wir sind wieder da')).actions[0].title, 'The lecture continues');
    assert.equal(app.db.get('SELECT paused_at FROM live_sessions WHERE id = ?', sid).paused_at, null);

    set('[action: lecture.chapter | {"title":"Eigenwerte"}]\n\nKapitel.');
    app.db.run('UPDATE live_chapters SET started = ? WHERE session_id = ?', new Date(Date.now() - 600_000).toISOString(), sid);
    const chapter = (await ask(app, 'prof', 'neues Kapitel Eigenwerte')).actions[0];
    assert.deepEqual([chapter.ok, chapter.title], [true, 'Chapter 2 started']);
    assert.deepEqual((await app.call('prof', 'GET', `/api/live/sessions/${sid}/chapters`)).body.chapters.map((c) => c.name), ['Chapter 1', 'Eigenwerte']);
    assert.ok(app.db.all("SELECT detail FROM audit WHERE action = 'assistant_action'").length >= 3, 'changes are audited');

    set('[action: lecture.break | {}]\n\nPause.');
    const student = (await ask(app, 'ann', 'pause')).actions[0];
    assert.equal(student.ok, false);
    assert.equal(student.error, 'Only the lecturer can do that.');
    const other = (await ask(app, 'other', 'pause')).actions[0];
    assert.equal(other.ok, false, 'another lecturer has no lecture of their own running');
    assert.equal(app.db.get('SELECT paused_at FROM live_sessions WHERE id = ?', sid).paused_at, null, 'and it did not touch this one');
  } finally {
    await app.close();
  }
});

test('the assistant opens the pages that were missing, by their English and German names', async () => {
  const { app, set } = await setup('');
  try {
    const to = async (name, who = 'ann') => {
      set(`[action: app.navigate | {"to":"${name}"}]\n\nOk.`);
      const a = (await ask(app, who, 'open it')).actions[0];
      return a.ok ? a.client.path : a.error;
    };
    assert.equal(await to('lectures'), '/lectures');
    assert.equal(await to('vorlesungen'), '/lectures', 'Vorlesungen is the Lectures page');
    assert.equal(await to('kurse'), '/courses');
    assert.equal(await to('sign'), '/sign');
    assert.equal(await to('lernschild'), '/sign');
    assert.equal(await to('study_sign'), '/sign');
    assert.equal(await to('meetings'), '/meetings');
    assert.equal(await to('dokumente'), '/library');
    assert.equal(await to('my_tools'), '/apps');
    assert.equal(await to('stundenplan'), '/schedule');
    assert.equal(await to('sign', 'prof'), '/sign');
  } finally {
    await app.close();
  }
});

// ---- German and English ----------------------------------------------------------------------------------------

test('spoken page names: Vorlesungen is the lectures, Kurse the courses, and the study sign is reachable in both languages', async () => {
  const { matchCommand } = await load('features/commands.js');
  const go = (text, role = 'student') => {
    const calls = [];
    const c = matchCommand(text, { role, navigate: (p) => calls.push(p), setTheme() {}, stop() {}, stopListening() {}, newChat() {}, language: 'de' });
    c?.run();
    return c ? calls[0] : null;
  };
  assert.equal(go('öffne Vorlesungen'), '/lectures');
  assert.equal(go('zeig mir meine Vorlesungen'), '/lectures');
  assert.equal(go('open lectures'), '/lectures');
  assert.equal(go('öffne Kurse'), '/courses');
  assert.equal(go('open the study sign'), '/sign');
  assert.equal(go('öffne Lernschild'), '/sign');
  assert.equal(go('open study sign', 'lecturer'), '/sign');
  assert.equal(go('was ist eine Vorlesung?'), null, 'a question is still a question');
});

test('a lecturer can say "new chapter" or "wir machen Pause" in either language; a question stays a question', async () => {
  const { lectureCommand } = await load('features/lecture-voice.js');
  const type = (t) => lectureCommand(t)?.type ?? null;
  for (const t of ['new chapter', 'Next chapter', 'start a new chapter', 'neues Kapitel', 'nächstes Kapitel', 'naechstes Kapitel']) assert.equal(type(t), 'chapter', t);
  for (const t of ['take a break', "let's take a short break", 'break', 'Pause', 'wir machen Pause', 'Wir machen jetzt eine kurze Pause', 'Pause machen', 'machen wir Pause']) assert.equal(type(t), 'break', t);
  for (const t of ["we're back", 'let us continue', 'resume', 'end the break', 'weiter', 'wir machen weiter', 'Pause beenden', 'wir sind wieder da', 'wir sind zurueck']) assert.equal(type(t), 'resume', t);
  assert.deepEqual(lectureCommand('New chapter: Eigenvalues'), { type: 'chapter', title: 'Eigenvalues' });
  assert.deepEqual(lectureCommand('neues Kapitel: Eigenwerte und Eigenvektoren'), { type: 'chapter', title: 'Eigenwerte und Eigenvektoren' });
  assert.deepEqual(lectureCommand('neues Kapitel über Matrizen'), { type: 'chapter', title: 'Matrizen' });
  for (const t of ['what is an eigenvalue?', 'the next chapter of the book says hello', 'take a look at the break room', 'Pausenbrot ist lecker', 'explain the last chapter again', 'was passiert in der Pause?', '', null]) assert.equal(lectureCommand(t), null, String(t));
});

test('every text added with these features has a German version, and the dynamic ones too', async () => {
  const { DE, PATTERNS } = await load('core/i18n-de.js');
  const translate = (s) => (Object.hasOwn(DE, s) ? DE[s] : PATTERNS.map(([re, fn]) => (re.test(s) ? s.replace(re, (...m) => fn(...m.slice(1, -2))) : null)).find(Boolean));
  const same = new Set(['Text', 'English']); // the same word in both languages
  const needed = [
    'Take a break', 'New chapter', 'Resume the lecture', 'Chapters', 'Join with the next chapter', 'Delete what was recorded here', 'Name this chapter',
    'Explanation too long', 'A bit boring', 'On a break', 'Time slot', 'Study sign', 'Show the sign', 'More options', 'Design with Citrus', 'Language', 'Message',
    'The lecture is on a break. You can answer when it continues.', 'The lecture is on a break. You can flag a moment when it continues.', 'A lecture needs at least one chapter.',
    'Citrus is still designing. Wait a minute and try again.', 'The assistant is not connected yet.', 'Showing the study sign', 'Break started',
    'You have no live lecture right now. Start one in Lectures.', 'Turn the bar', 'Fade the circle', 'Hide tools',
    'Chapter 3 started', 'Deleted 2 lines of transcript and 1 piece of audio', 'Deleted 3 pieces of audio', 'Morning 08:15–11:30', 'Period 4 · 14:00', 'Opening sign', 'Opening lectures',
  ];
  const missing = needed.filter((s) => !same.has(s) && !translate(s));
  assert.deepEqual(missing, []);
  assert.equal(translate('Chapter 3 started'), 'Kapitel 3 gestartet');
  assert.equal(translate('Deleted 1 line of transcript and 2 pieces of audio'), '1 Zeile Mitschrift und 2 Audioabschnitte gelöscht');
  assert.equal(translate('Opening lectures'), 'Öffne Vorlesungen');
  assert.equal(translate('Opening ML101'), 'Öffne ML101', 'a course code stays as it is');
  assert.equal(translate('Afternoon 14:00–15:30'), 'Nachmittag 14:00–15:30');
  for (const [key, value] of Object.entries(DE)) {
    if (/Chapter|chapter|break|sign|Sign/.test(key)) assert.notEqual(value, key, `${key} is a real translation`);
  }
});
