'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAcademicSnapshot, parseSnapshot } = require('../src/ai/academic-snapshot');
const { createAiService } = require('../src/ai/service');
const { assistantPrompt } = require('../src/ai/prompts');
const file = require('../config/editions/oth').academicSnapshot;
const academic = createAcademicSnapshot({ root: path.join(__dirname, '..'), file });

test('the complete supplied snapshot retains source pages, OCR coordinates and programme coverage', () => {
  const { docs, programmes, date } = academic.load();
  assert.equal(date, '2026-11-08');
  assert.equal(programmes.length, 53);
  const pages = docs.filter((d) => d.source_page);
  assert.equal(new Set(pages.map((d) => d.source_id)).size, 182);
  assert.equal(new Set(pages.map((d) => `${d.source_id}:${d.source_page}`)).size, 572);
  assert.ok(pages.some((d) => /OCR_POSITIONED_TOKENS/.test(d.content) && /unverified/.test(d.extraction)));
  assert.ok(pages.some((d) => /DRAWN_REGIONS/.test(d.content)));
  assert.throws(() => parseSnapshot('partial upload'), /Incomplete/);
});

test('programme and semester retrieval works in English, German, speech casing and a corrected programme', () => {
  assert.deepEqual(academic.mentioned('what does an ib student have tomorrow? oh i do dtm'), ['DTM', 'IB']);
  assert.deepEqual(academic.fromProfile('Digital Technology and Management'), ['DTM']);
  assert.deepEqual(academic.mentioned('the library is open today'), []);
  for (const q of ['DTM semester 1 timetable', 'ich studiere dtm im 1. Semester, was habe ich morgen?']) {
    const hits = academic.find(q);
    assert.equal(hits[0].source_id, 'S077');
    assert.equal(hits[0].source_page, 3);
    assert.ok(hits.every((h) => h.programmes.includes('DTM')));
  }
  assert.equal(academic.find('what do I have tomorrow?', { profile: { programme: 'DTM', semester: 1 } })[0].source_page, 3);
  assert.deepEqual(academic.find('I do DTM\nwhere is the library?'), [], 'a past programme mention does not hijack unrelated searches');
  assert.deepEqual(academic.upcoming({ codes: ['DTM'] }), [], 'OCR and layout are not normalized events');
});

test('exam terms, curriculum cohorts, calendar conflicts and page citations stay in the model input', () => {
  const exam = academic.find('DTM Prüfungsplan letztes Semester')[0];
  assert.equal(exam.source_id, 'S078');
  assert.match(exam.header, /SS 2026/);
  assert.match(exam.header, /older_or_other_semester/);
  assert.ok(academic.find('DTM study plan').every((d) => d.kind.startsWith('curriculum_plan')));
  const db = { get: () => ({ programme: 'DTM', semester: 1 }), all: () => [] };
  const ai = createAiService({ db, env: {}, academic });
  const result = ai.retrieveContext({ id: 1, institution_id: 1 }, 'what do I have tomorrow?');
  assert.ok(result.references.length);
  assert.equal(result.references[0].sourcePage, 3);
  assert.match(result.sources[0].url, /#page=3$/);
  assert.match(result.references[0].excerpt, /DTM,BA,Sem\. 1/);
  const original = academic.load().docs.find((d) => d.source_id === 'S077' && d.source_page === 3);
  assert.equal(result.references[0].excerpt, original.content, 'fixed-width layout is never shortened or flattened');
  const cal = ai.retrieveContext({ id: 1, institution_id: 1 }, 'Fronleichnam 2027');
  assert.match(JSON.stringify(cal.references), /SOURCE_CONFLICT/);
  assert.match(JSON.stringify(cal.references), /20270531/);
  const system = assistantPrompt({ site: {}, user: { name: 'Student', role: 'student', institution: 'OTH' }, context: academic.describe({ codes: ['DTM'] }).join('\n'), sources: result.references });
  assert.ok(system.endsWith('</SOURCES>'));
  assert.ok(system.length < 64000);
  assert.match(system, /unverified OCR/);
});
