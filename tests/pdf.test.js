'use strict';
/** Notes as PDF, made on the device: Markdown in, a valid A4 PDF out, with the standard fonts and coloured boxes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);

/** Every cross-reference entry points at its object, and the trailer points at the table. */
function checkStructure(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.ok(text.startsWith('xref', xref), 'startxref points at the table');
  const offsets = text.slice(xref).split('\n').filter((l) => / 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
  offsets.forEach((offset, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, offset), `object ${i + 1} is where the table says`));
  for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    assert.ok(text.startsWith('\nendstream', start + Number(m[1])), 'each stream is as long as it says');
  }
  return text;
}

test('Markdown becomes blocks: headings, lists, boxes, tables, code and graphs', async () => {
  const { parseMarkdown, parseInline } = await load('core/pdf.js');
  const blocks = parseMarkdown('# Title\n\nSome **bold** text\nthat continues.\n\n- one\n  - two\n1. first\n\n> **Key idea:** remember\n> this\n\n| A | B |\n|---|---|\n| 1 | good |\n\n```chart\n{"type":"bar"}\n```\n\n---');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'quote', 'table', 'chart', 'rule']);
  assert.equal(blocks[1].text, 'Some **bold** text that continues.');
  assert.deepEqual(blocks[2].items.map((i) => [i.depth, i.marker]), [[0, '•'], [1, '•'], [0, '1.']]);
  assert.deepEqual(blocks[4].rows, [['1', 'good']]);
  assert.deepEqual(parseInline('a **b** *c* `d` [e](https://x.y) snake_case_word'), [
    { text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', italic: true }, { text: ' ' }, { text: 'd', code: true }, { text: ' ' }, { text: 'e', link: 'https://x.y' }, { text: ' snake_case_word' },
  ]);
});

test('text keeps German, Greek and maths, and drops what the fonts cannot show', async () => {
  const { pdfText } = await load('core/pdf.js');
  assert.equal(pdfText('Größe, Übung – „gut“ … 5 €'), 'Größe, Übung – „gut“ … 5 €');
  assert.equal(pdfText('λ ≤ √x → ∞'), 'λ ≤ √x → ∞', 'kept for the Symbol font');
  assert.equal(pdfText('λ ≤ √x', { spell: true }), 'lambda <= sqrtx');
  assert.equal(pdfText('done ✅ 🎉 x₂ ł'), 'done v  x2 l');
  assert.equal(pdfText('漢'), '?');
});

test('notes become a valid PDF with a title, the timeline, coloured boxes and page numbers', async () => {
  const { notesPdf } = await load('core/pdf.js');
  const long = Array.from({ length: 80 }, (_, i) => `- point ${i} with enough words to wrap around the line at least once in the layout`).join('\n');
  const bytes = notesPdf({
    markdown: `# Eigenvalues (notes)\n\n> **Explain it better · 06:55 · P2:** Start from Av = λv.\n\n| Section | Status |\n|---|---|\n| P2 | trouble |\n\n${long}`,
    subtitle: 'MA2 · 14 Nov 2026',
    figure: { minutes: [{ minute: 1, status: 'good' }, { minute: 2, status: 'trouble' }], audience: 'lecturer' },
  });
  const text = checkStructure(bytes);
  assert.match(text, /\/Title \(Eigenvalues \\\(notes\\\)\)/, 'the first heading is the title, brackets escaped');
  assert.match(text, /\/BaseFont \/Symbol/);
  assert.match(text, /\(Explain it better · 06:55 · P2\) Tj/, 'the box label, in WinAnsi');
  assert.match(text, /\/F6 [\d.]+ Tf \(l\) Tj/, 'λ is drawn with the Symbol font');
  assert.match(text, /0\.851 0\.231 0\.231 rg/, 'red for the follow-up box and the trouble status');
  const pages = (text.match(/\/Type \/Page /g) || []).length;
  assert.ok(pages >= 3, `long notes run over several pages (${pages})`);
  assert.match(text, new RegExp(`\\(${pages} / ${pages}\\) Tj`), 'page numbers');
});

test('graphs are embedded as pictures', async () => {
  const { notesPdf } = await load('core/pdf.js');
  const code = '{"type":"bar"}';
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const text = checkStructure(notesPdf({ markdown: `# G\n\n\`\`\`chart\n${code}\n\`\`\``, images: new Map([[code, { data: jpeg, width: 4, height: 2 }]]) }));
  assert.match(text, /\/Subtype \/Image \/Width 4 \/Height 2 [^>]*\/Filter \/DCTDecode/);
  assert.match(text, /\/Im1 Do/);
});
