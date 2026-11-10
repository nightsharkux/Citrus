'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCorpus, isCorpus } = require('../src/modules/knowledge/routes');

const SAMPLE = `RULES HEADER
1. Cite the file and page.
==========
BEGIN_DOCUMENT SOURCE_ID=CAMPUS_PDF_01
ORIGINAL_FILENAME=Form.pdf
DOCUMENT_TYPE=FORM
PAGES=2

----- BEGIN PAGE 1 OF 2 | Form.pdf -----
Hello      world


text
----- END PAGE 1 -----

----- BEGIN PAGE 2 OF 2 | Form.pdf -----
[NO EXTRACTABLE TEXT ON THIS PAGE; inspect the original PDF image]
----- END PAGE 2 -----
END_DOCUMENT SOURCE_ID=CAMPUS_PDF_01
`;

test('the university corpus is split by PDF page with the source in each entry', () => {
  assert.ok(isCorpus(SAMPLE));
  const records = parseCorpus(SAMPLE);
  assert.equal(records.length, 2, 'rules entry plus the one page that has text');
  assert.match(records[0].title, /How to use/);
  assert.equal(records[1].externalId, 'CAMPUS_PDF_01:p1');
  assert.match(records[1].content, /^\[Source: Form\.pdf, PDF p\. 1\]/);
  assert.ok(!records[1].content.includes('      '), 'table padding is collapsed');
});

test('a very long page is split instead of cut off', () => {
  const long = SAMPLE.replace('Hello      world', 'x'.repeat(14000));
  const parts = parseCorpus(long).filter((r) => r.externalId.startsWith('CAMPUS_PDF_01:p1'));
  assert.equal(parts.length, 3);
  assert.ok(parts.every((r) => r.content.length <= 7000));
});
