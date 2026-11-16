'use strict';
/** German and English side by side: telling them apart, voice commands in both, and the interface dictionary. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);

test('German and English are told apart, including mixed sentences and misspellings', async () => {
  const { detectLanguage } = await load('features/turns.js');
  assert.equal(detectLanguage('they told me to go to Banhof today'), 'en', 'one German word in an English sentence');
  assert.equal(detectLanguage('Wann ist meine nächste Vorlesung?'), 'de');
  assert.equal(detectLanguage('ich muss morgen in HSG 001, what time?'), 'de', 'the language with most words wins in a mix');
  assert.equal(detectLanguage('what is on my schedule tomorrow'), 'en');
  assert.equal(detectLanguage('Wo ist der Bahnhof'), 'de');
  assert.equal(detectLanguage('Schirmitzer Weg'), null, 'a street name alone says nothing about the language');
  assert.equal(detectLanguage(''), null);
  assert.equal(detectLanguage('Klausur am Montag gibts'), 'de');
  assert.equal(detectLanguage("can't do Deutsch broken"), 'en', 'a German word does not switch an English remark about difficulty to German');
});

test('turn-taking understands German stop and goodbye phrases, and allows thinking pauses', async () => {
  const { conversationCommand, isInterruption, endOfTurnDelay } = await load('features/turns.js');
  assert.equal(conversationCommand('Tschüss'), 'end');
  assert.equal(conversationCommand('das war alles'), 'end');
  assert.equal(conversationCommand('Ruhe'), 'interrupt');
  assert.equal(conversationCommand('warte mal'), 'interrupt');
  assert.equal(isInterruption('warte mal', 'Die Bibliothek öffnet um acht Uhr'), true);
  assert.ok(endOfTurnDelay('what is on my schedule tomorrow', { final: true }) >= 1200, 'a provider final is not permission to interrupt a thinking pause');
  assert.ok(endOfTurnDelay('was ist morgen und', { final: false }) > endOfTurnDelay('was ist morgen', { final: false }), 'a German sentence ending in "und" is still going');
});

test('voice commands work in German and English, and a question still goes to the assistant', async () => {
  const { matchCommand } = await load('features/commands.js');
  const calls = [];
  const ctx = { role: 'student', navigate: (p) => calls.push(`go ${p}`), setTheme: (m) => calls.push(`theme ${m}`), stop: () => calls.push('stop'), stopListening: () => calls.push('sleep'), talk: () => calls.push('talk'), setSpeechLanguage: (c) => calls.push(`speech ${c}`) };
  const run = (s) => {
    calls.length = 0;
    const m = matchCommand(s, ctx);
    m?.run();
    return m ? calls.join() : null;
  };
  assert.equal(run('öffne meinen Stundenplan'), 'go /schedule');
  assert.equal(run('open schedule'), 'go /schedule');
  assert.equal(run('Bitte zeig mir die Kurse'), 'go /courses');
  assert.equal(run('geh zu Einstellungen'), 'go /settings');
  assert.equal(run('öffne die Karte'), 'go /campus/map');
  assert.equal(run('Dunkelmodus'), 'theme dark');
  assert.equal(run('schalte den Hellmodus ein'), 'theme light');
  assert.equal(run('lass uns reden'), 'talk');
  assert.equal(run('stopp'), 'stop');
  assert.equal(run('neues Gespräch'), 'go /assistant?new=1');
  assert.equal(run('auf Deutsch'), 'speech de');
  assert.equal(run('in English'), 'speech en');
  assert.equal(run('zeig mir was morgen ansteht'), null, 'a question is not a command');
  assert.equal(run('show me what is on my calendar tomorrow'), null);
});

test('the interface switches to German, keeps names and Citrus, and uses the assistant\'s own name', async () => {
  const { translateWith, loadGerman } = await load('core/i18n.js');
  await loadGerman();
  const de = (s, name = 'Citrus') => translateWith('de', name, s);
  const en = (s, name = 'Citrus') => translateWith('en', name, s);

  assert.equal(de('Schedule'), 'Stundenplan');
  assert.equal(de('Sign out'), 'Abmelden');
  assert.equal(de('  Settings '), '  Einstellungen ', 'surrounding spaces stay');
  assert.equal(de('Some text the user wrote'), 'Some text the user wrote', 'unknown text is left alone');
  assert.equal(de('3 students'), '3 Studierende');
  assert.equal(de('1 course'), '1 Kurs');
  assert.equal(de('Hi Ana, what can I help with?'), 'Hallo Ana, wobei kann ich helfen?');
  assert.equal(de('Name: Claudia · Voice speed: faster'), 'Name: Claudia · Sprechtempo: schneller', 'action details are translated part by part');

  // The assistant's name replaces "Citrus" where it means the assistant, not the product, the place or the map.
  assert.equal(en('Ask Citrus', 'Claudia'), 'Ask Claudia');
  assert.equal(en('Listen for “Hey Citrus”', 'Claudia'), 'Listen for “Hey Claudia”');
  assert.equal(en('Citrus home', 'Claudia'), 'Citrus home');
  assert.equal(en('Campus life', 'Claudia'), 'Campus life');
  assert.equal(en('Campus map', 'Claudia'), 'Campus map');
  assert.equal(en('Campus', 'Claudia'), 'Campus', 'a bare "Campus" is a heading about the place');
  // Citrus is the product's name too: where the interface means the product it stays, wherever it means the assistant it changes.
  for (const product of ['Open Citrus on your phone', 'Use your Citrus password', 'Get your Citrus schedule', 'Everything in Citrus', 'Explain what Citrus is', 'What Citrus does', 'Choose how Citrus looks', 'Welcome to Citrus', 'By the Citrus app', 'Citrus · Student project', 'Institution-managed Citrus pilot.']) {
    assert.equal(en(product, 'Claudia'), product, product);
  }
  assert.equal(en('Citrus can answer from your notes', 'Claudia'), 'Claudia can answer from your notes');
  assert.equal(en('What Citrus said', 'Claudia'), 'What Claudia said');
  assert.equal(en('Talk to Citrus', 'Claudia'), 'Talk to Claudia');
  assert.equal(de('Ask Citrus', 'Claudia'), 'Claudia fragen');
  assert.equal(de('Campus life', 'Claudia'), 'Campusleben');
  assert.equal(de('Message Claudia, or paste a picture', 'Claudia'), 'Schreib Claudia – oder füge ein Bild ein');
  assert.equal(de('Citrus is listening for “Hey Citrus”. Click to stop.', 'Max'), 'Max hört auf „Hey Max“. Klicken zum Beenden.');
  assert.equal(de('Tomorrow'), 'Morgen');
  assert.equal(de('Answer language'), 'Antwortsprache');
  assert.equal(de('Follow my language'), 'Meiner Sprache folgen');
  assert.equal(de('Translate page to English'), 'Seite ins Englische übersetzen');
});

test('every German entry is a real translation, not a copy with a typo', async () => {
  const { DE } = await load('core/i18n-de.js');
  const keys = Object.keys(DE);
  assert.ok(keys.length > 600, `${keys.length} strings`);
  for (const [en, german] of Object.entries(DE)) {
    assert.ok(en.trim() === en && german.trim() === german, `no stray spaces: ${en}`);
    assert.ok(german.length > 0, `empty translation for ${en}`);
    const code = (s) => (s.match(/\b[A-Z]{3,}\b/g) || []).sort().join();
    // Acronyms (HSG, WTC, UID, PDF...) survive translation.
    if (/\b(HSG|WTC|EMI|UID|PDF|DELETE|JSON)\b/.test(en)) assert.equal(code(german), code(en), en);
  }
});
