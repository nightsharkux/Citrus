'use strict';
/**
 * Documents for Citrus: any file in, readable library entries out. Text is taken from the file itself; pictures,
 * scanned PDFs and PDFs with undecodable fonts are read by the AI; the result downloads as one .txt in the library
 * format that imports back unchanged. Lecturers manage their own uploads, admins all of them, students none.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { startApp } = require('./helpers');
const { plan, splitPages, parseCard } = require('../src/modules/library/service');
const { parseCorpus, isCorpus } = require('../src/modules/knowledge/routes');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const b64 = (buffer) => Buffer.from(buffer).toString('base64');

/** A one-page PDF whose page is a JPEG picture, like a scanner makes. */
function scannedPdf() {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >> endobj\n', 'latin1'),
    Buffer.from(`4 0 obj << /Type /XObject /Subtype /Image /Width 1200 /Height 1600 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'latin1'),
    jpeg,
    Buffer.from('\nendstream\nendobj\n5 0 obj << /Length 30 >>\nstream\nq 595 0 0 842 0 0 cm /Im0 Do Q\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
}

/** A two-page PDF with text in a font that cannot be decoded (two-byte glyph ids) and no pictures. */
function glyphPdf() {
  const page = (n) => `${n} 0 obj << /Type /Page /Parent 2 0 R /Contents ${n + 10} 0 R >> endobj\n`;
  const content = (n) => {
    const data = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td <00410042004300440045> Tj ET', 'latin1'));
    return Buffer.concat([Buffer.from(`${n} 0 obj << /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
  };
  return Buffer.concat([Buffer.from(`%PDF-1.5\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n${page(3)}${page(4)}`, 'latin1'), content(13), content(14), Buffer.from('trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1')]);
}

function gateway() {
  const state = { calls: [] };
  return {
    state,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      state.calls.push(body);
      const system = body.messages[0].content;
      let reply = 'Prüfungsanmeldung | 09.12.2026 bis 17.12.2026\nRaum | HSG 001';
      if (/You file a university document/.test(system)) reply = JSON.stringify({ title: 'Exam registration notice WS 2026/27', type: 'notice', summary: 'When and where to register for exams.', applies_to: 'All programmes, WS 2026/27', key_facts: ['Registration 09.12.2026 to 17.12.2026'], keywords: ['Prüfungsanmeldung', 'exam registration'] });
      else if (/Transcribe ONLY pages/.test(system)) reply = '=== PAGE 1 ===\nStudien- und Prüfungsordnung, § 1 Geltungsbereich\n=== PAGE 2 ===\n§ 2 Regelstudienzeit: sieben Semester';
      return Response.json({ choices: [{ message: { content: reply } }] });
    },
  };
}

test('every kind of file gets a reading plan', () => {
  assert.equal(plan({ name: 'board.png', buffer: PNG }).pages[0].method, 'vision');
  const scan = plan({ name: 'scan.pdf', buffer: scannedPdf() });
  assert.deepEqual([scan.kind, scan.pages.length, scan.pages[0].method, scan.pages[0].mime], ['scan', 1, 'vision', 'image/jpeg']);
  const glyphs = plan({ name: 'spo.pdf', buffer: glyphPdf() });
  assert.deepEqual([glyphs.kind, glyphs.pages[0].method, glyphs.pages[0].page, glyphs.pages[0].last_page], ['pdf-ai', 'pdf', 1, 2], 'the AI reads the PDF itself, pages 1 to 2');
  const notes = plan({ name: 'notes.md', buffer: Buffer.from('# Week 1\n\nSorting.\n\n# Week 2\n\nSearching.') });
  assert.deepEqual([notes.unit, notes.pages[0].method], ['part', 'text'], 'a text file has parts, not invented page numbers');
  assert.throws(() => plan({ name: 'old.doc', buffer: Buffer.from('binary') }), /Old Office formats/);
  assert.deepEqual(splitPages('=== PAGE 3 ===\nA\n=== PAGE 4 ===\nB\n=== PAGE 9 ===\nC', 3, 4), { 3: 'A', 4: 'B' }, 'pages outside the run are dropped');
  assert.equal(parseCard('not json', 'Fallback').title, 'Fallback');
});

test('a text file is filed at once, without the AI, and Citrus can find it', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    await app.lecturer('prof');
    await app.register('stu');
    const content = 'Prüfungsanmeldung WS 2026/27\n\nDie Anmeldung zu den Prüfungen läuft vom 09.12.2026 bis 17.12.2026 über PRIMUSS.';
    assert.equal((await app.call('stu', 'POST', '/api/library/documents', { name: 'pruefung.txt', data: b64(content) })).status, 403, 'students do not upload');
    assert.equal((await app.call('stu', 'GET', '/api/library/documents')).status, 403);
    const up = await app.call('prof', 'POST', '/api/library/documents', { name: 'pruefung.txt', mime: 'text/plain', data: b64(content) });
    assert.equal(up.status, 201);
    assert.equal(up.body.document.status, 'ready');
    assert.ok(up.body.document.entries >= 2, 'an overview and the text');
    const found = await app.call('stu', 'GET', `/api/knowledge/search?q=${encodeURIComponent('Prüfungsanmeldung PRIMUSS')}`);
    assert.ok(found.body.results.some((r) => /PRIMUSS/.test(JSON.stringify(r))), 'the assistant’s search finds it');
    assert.equal((await app.call('prof', 'POST', '/api/library/documents', { name: 'x.bin', data: b64('\u0000\u0001') })).status, 400);
  } finally {
    await app.close();
  }
});

test('pictures, scans and undecodable PDFs are read by the AI, then download as one .txt that imports back', async () => {
  const fixture = gateway();
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: fixture.fetchImpl });
  try {
    await app.login('admin');
    await app.lecturer('prof');
    await app.lecturer('other');

    // A photo of a notice
    const photo = await app.call('prof', 'POST', '/api/library/documents', { name: 'aushang.png', mime: 'image/png', data: b64(PNG) });
    assert.equal(photo.body.document.status, 'reading');
    assert.equal(photo.body.document.pending, 1);
    assert.equal((await app.call('other', 'POST', `/api/library/documents/${photo.body.document.id}/read`)).status, 403, 'not their upload');
    const read = await app.call('prof', 'POST', `/api/library/documents/${photo.body.document.id}/read`);
    assert.equal(read.body.document.status, 'ready');
    assert.equal(read.body.document.title, 'Exam registration notice WS 2026/27');
    const sentPicture = fixture.state.calls.find((c) => JSON.stringify(c.messages.at(-1).content).includes('image_url'));
    assert.ok(sentPicture, 'the picture reached the model');
    assert.equal(sentPicture.model, 'google/gemini-3.8-flash', 'reading uses the lookup model');
    const entry = app.db.get("SELECT content FROM institution_knowledge WHERE external_id = ?", `doc${photo.body.document.id}:p1`);
    assert.match(entry.content, /read from a picture by AI \(unverified\)/);
    assert.match(entry.content, /HSG 001/);

    // A scanned PDF: its page picture is read the same way.
    const scan = await app.call('prof', 'POST', '/api/library/documents', { name: 'scan.pdf', mime: 'application/pdf', data: b64(scannedPdf()) });
    assert.equal(scan.body.document.kind, 'scan');
    assert.equal((await app.call('prof', 'POST', `/api/library/documents/${scan.body.document.id}/read`)).body.document.status, 'ready');

    // A PDF whose fonts cannot be decoded: the PDF itself goes to the model, and its pages come back separately.
    const spo = await app.call('prof', 'POST', '/api/library/documents', { name: 'SPO.pdf', mime: 'application/pdf', data: b64(glyphPdf()) });
    assert.equal(spo.body.document.kind, 'pdf-ai');
    const spoRead = await app.call('prof', 'POST', `/api/library/documents/${spo.body.document.id}/read`);
    assert.equal(spoRead.body.document.status, 'ready');
    const filePart = fixture.state.calls.map((c) => c.messages.at(-1).content).flat().find((part) => part?.type === 'file');
    assert.equal(filePart.file.media_type, 'application/pdf');
    assert.equal(filePart.file.filename, 'SPO.pdf');
    assert.match(app.db.get("SELECT content FROM institution_knowledge WHERE external_id = ?", `doc${spo.body.document.id}:p2`).content, /Regelstudienzeit/);
    assert.equal(app.db.get('SELECT source FROM knowledge_documents WHERE id = ?', spo.body.document.id).source, null, 'the original PDF is not kept once read');

    // One file with everything, for Citrus or any other AI.
    const file = await app.call('prof', 'GET', '/api/library/export.txt', undefined, { raw: true });
    assert.equal(file.status, 200);
    const txt = await file.text();
    assert.match(txt, /=== READING AND INGESTION RULES ===/);
    assert.match(txt, /ORIGINAL_FILENAME=aushang\.png/);
    assert.match(txt, /READ_METHOD=ai-vision/);
    assert.match(txt, /KEY_FACTS=\n- Registration 09\.12\.2026 to 17\.12\.2026/);
    assert.ok(isCorpus(txt));
    const again = parseCorpus(txt);
    assert.ok(again.some((r) => /Regelstudienzeit/.test(r.content) && /SPO\.pdf, PDF p\. 2/.test(r.content)), 'it imports back with file and page');
    assert.equal(again[0].title, 'How to use the university documents', 'the reading rules become an entry of their own');

    // Managing uploads
    const others = await app.call('other', 'GET', '/api/library/documents');
    assert.equal(others.body.documents.length, 0, 'lecturers see their own uploads');
    assert.equal((await app.call('admin', 'GET', '/api/library/documents')).body.documents.length, 3, 'admins see all');
    assert.equal((await app.call('other', 'DELETE', `/api/library/documents/${photo.body.document.id}`)).status, 403);
    assert.equal((await app.call('admin', 'DELETE', `/api/library/documents/${photo.body.document.id}`)).status, 200);
    assert.equal(app.db.get("SELECT COUNT(*) n FROM institution_knowledge WHERE external_id LIKE ?", `doc${photo.body.document.id}:%`).n, 0, 'its entries go too');
  } finally {
    await app.close();
  }
});

test('without the AI, pictures fail with a clear reason and library files are imported as they are', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const photo = await app.call('admin', 'POST', '/api/library/documents', { name: 'board.jpg', data: b64(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20)])) });
    assert.equal(photo.body.document.status, 'failed');
    assert.match(photo.body.document.error, /AI/);
    const jsonl = '{"id":"a1","title":"Library hours","content":"The library opens at 8:00."}\n';
    const imported = await app.call('admin', 'POST', '/api/library/documents', { name: 'pack.jsonl', data: b64(jsonl) });
    assert.equal(imported.body.document.status, 'ready');
    assert.equal(imported.body.document.entries, 1);
  } finally {
    await app.close();
  }
});
