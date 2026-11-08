'use strict';
/** Textbook-style maths in assistant answers: LaTeX → MathML, safe by construction, listenable when read aloud. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'core', file)).href);

test('the quadratic formula is drawn as stacked fractions, a root sign and real exponents', async () => {
  const { mathHtml } = await load('math.js');
  const html = mathHtml('x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', { display: true });
  assert.match(html, /^<math display="block">/);
  for (const tag of ['<mfrac>', '<msqrt>', '<msup><mi>b</mi><mn>2</mn></msup>']) assert.ok(html.includes(tag), tag);
  assert.ok(html.includes('<mo>±</mo>') && html.includes('<mo>−</mo>'), 'real plus-minus and minus signs, not keyboard characters');
  assert.ok(!html.includes('\\'), 'no raw LaTeX left over');
});

test('sums, integrals, matrices, cases and delimiters that grow are understood', async () => {
  const { mathHtml } = await load('math.js');
  assert.match(mathHtml('\\sum_{i=1}^{n} i', { display: true }), /<munderover><mo>∑<\/mo>/, 'limits sit above and below in display mode');
  assert.match(mathHtml('\\sum_{i=1}^{n} i'), /<msubsup><mo>∑<\/mo>/, 'and beside the sign inside a sentence');
  assert.match(mathHtml('\\int_0^1 x^2\\,dx', { display: true }), /<msubsup><mo>∫<\/mo><mn>0<\/mn><mn>1<\/mn>/);
  assert.match(mathHtml('\\left( \\frac{a}{b} \\right)'), /<mo fence="true" stretchy="true" form="prefix">\(<\/mo>/);
  const matrix = mathHtml('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', { display: true });
  assert.equal((matrix.match(/<mtr>/g) || []).length, 2);
  assert.equal((matrix.match(/<mtd>/g) || []).length, 4);
  assert.match(mathHtml('f(x)=\\begin{cases} x & x>0 \\\\ 0 & \\text{otherwise} \\end{cases}'), /<mtext>otherwise<\/mtext>/);
  assert.match(mathHtml('\\alpha + \\Delta x \\leq \\infty'), /<mi>α<\/mi>.*<mi mathvariant="normal">Δ<\/mi>.*<mo>≤<\/mo>.*∞/);
});

test('maths cannot inject markup and unknown input degrades instead of throwing', async () => {
  const { mathHtml } = await load('math.js');
  const { markdown } = await load('markdown.js');
  const attack = mathHtml('\\text{<img src=x onerror=alert(1)>} <script>', { display: false });
  assert.ok(!/<img|<script/i.test(attack), 'text is escaped');
  assert.ok(!/<img|<script/i.test(String(markdown('$\\text{<img src=x onerror=alert(1)>}$ and <script>alert(1)</script>'))));
  assert.match(mathHtml('\\constructor \\nonsense x'), /m-unknown/, 'unknown commands (even ones named like object properties) are shown as written');
  assert.doesNotThrow(() => mathHtml('\\frac{a'), 'an unfinished formula while streaming is fine');
  assert.doesNotThrow(() => mathHtml('{'.repeat(500)));
  assert.doesNotThrow(() => mathHtml('^_&\\\\'));
});

test('markdown puts formulas in their own blocks, keeps numbered steps together and leaves money alone', async () => {
  const { markdown } = await load('markdown.js');
  const html = String(markdown([
    'Solve $x^2 - 3x + 2 = 0$.',
    '',
    '$$x = \\frac{3 \\pm 1}{2}$$',
    '',
    '1. Identify the coefficients:',
    '   $$a = 1$$',
    '2. Substitute:',
    '$$x = \\frac{3 \\pm \\sqrt{1}}{2}$$',
    '3. Simplify.',
    '',
    'It costs $5 and $10 and `$x$` stays code.',
    '',
    '> **Key idea:** a quadratic has at most two roots.',
    '',
    '| Case | Roots |',
    '|---|---|',
    '| $D>0$ | two |',
  ].join('\n')));
  assert.equal((html.match(/<div class="math-block">/g) || []).length, 3, 'three display formulas');
  assert.equal((html.match(/<ol/g) || []).length, 1, 'a formula between steps does not restart the numbering');
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.match(html, /It costs \$5 and \$10 and <code>\$x\$<\/code> stays code\./);
  assert.match(html, /<blockquote class="callout"><p><strong>Key idea:<\/strong>/);
  assert.match(html, /<table>.*<th>Case<\/th>.*<math>/);
  assert.match(String(markdown('\\[ a^2 + b^2 = c^2 \\]')), /<div class="math-block"><math display="block">/, 'the \\[ \\] spelling works too');
});

test('an unfinished formula shows a placeholder while streaming and the text once the answer is complete', async () => {
  const { markdown } = await load('markdown.js');
  assert.match(String(markdown('Here:\n\n$$ \\frac{a', { streaming: true })), /math-block is-pending/);
  assert.ok(!/is-pending/.test(String(markdown('Here:\n\n$$ \\frac{a'))));
  assert.ok(!/action:|visual:/.test(String(markdown('[action: app.theme | {"mode":"dark"}]\n\nSwitching.'))), 'a cue that slipped through is never shown');
});

test('read-aloud turns formulas into words and drops markup', async () => {
  const { speakable } = await load('math.js');
  const spoken = speakable('## Roots\n\nSolve $x^2 = 4$, so **x** is $\\pm 2$ [1]. Cost: $5 and $10.\n\n$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$');
  assert.match(spoken, /x squared equals 4/);
  assert.match(spoken, /plus or minus 2/);
  assert.match(spoken, /the square root of b squared/);
  assert.match(spoken, /Cost: \$5 and \$10\./, 'money is read as written');
  assert.ok(!/[\\{}^*#]|\[1\]/.test(spoken.replace('$5 and $10', '')), 'no symbols or citation numbers are read out');
});
