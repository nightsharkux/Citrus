'use strict';
/** Graphs in answers: a safe formula parser and textbook-style SVG figures from ```chart blocks. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);

test('formulas are parsed, not evaluated as code', async () => {
  const { compileExpression } = await load('core/chart.js');
  const at = (expr, x) => compileExpression(expr)(x);
  assert.equal(at('2x^2 - 3x + 1', 2), 3, 'implicit multiplication and powers');
  assert.equal(at('-x^2', 3), -9, 'minus binds looser than the power');
  assert.equal(at('2^3^2', 0), 512, 'powers are right-associative');
  assert.equal(at('y = 3(x + 1)', 1), 6, '"y =" is fine');
  assert.equal(at('max(0, 10 - 2*x)', 7), 0);
  assert.ok(Math.abs(at('sin(pi/2) + ln(e)', 0) - 2) < 1e-12);
  assert.equal(at('sqrt x', 9), 3);
  for (const bad of ['alert(1)', 'constructor', 'x;process.exit()', 'window.location', '']) {
    assert.throws(() => compileExpression(bad), `rejected: ${bad}`);
  }
});

test('a supply-and-demand diagram is drawn as a labelled figure', async () => {
  const { chartSvg } = await load('core/chart.js');
  const svg = chartSvg({
    type: 'function', title: 'Supply and demand', x: { label: 'Quantity', min: 0, max: 10 }, y: { label: 'Price (EUR)', min: 0, max: 12 },
    functions: [{ name: 'Demand', expr: '10 - x' }, { name: 'Supply', expr: '2 + x' }],
    annotations: [{ x: 4, y: 6, label: 'Equilibrium' }], lines: [{ x: 4, label: 'Q* = 4' }],
  });
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  for (const text of ['Supply and demand', 'Quantity', 'Price (EUR)', 'Demand', 'Supply', 'Equilibrium', 'Q* = 4']) assert.ok(svg.includes(text), text);
  assert.equal((svg.match(/<path d="M/g) || []).length >= 2, true, 'two curves');
  assert.match(svg, /fill="#ffffff"/, 'on white, like a page');
});

test('bars, pies, data series and broken specs', async () => {
  const { chartSvg, parseChart } = await load('core/chart.js');
  const bar = chartSvg({ type: 'bar', title: 'Grades', x: { categories: ['1', '2', '3'] }, series: [{ name: 'WS', values: [4, 9, 2] }] });
  assert.equal((bar.match(/<rect x=/g) || []).length, 3);
  assert.match(chartSvg({ type: 'pie', x: { categories: ['Yes', 'No'] }, series: [{ values: [3, 1] }] }), /75%/);
  assert.match(chartSvg({ type: 'scatter', series: [{ name: 'Data', points: [[1, 2], [2, 3], [3, 5]] }] }), /<circle/);
  assert.match(chartSvg({ type: 'line', series: [] }), /could not be drawn/);
  assert.match(chartSvg({ title: '<script>alert(1)</script>', type: 'line', series: [{ points: [[0, 0], [1, 1]] }] }), /&lt;script&gt;/, 'text is escaped');
  assert.equal(parseChart('{"type": "line", "series": [],}').type, 'line', 'a trailing comma is forgiven');
  assert.equal(parseChart('not json'), null);
});

test('answers turn ```chart blocks into figures, and half-written ones into a placeholder', async () => {
  const { markdown } = await load('core/markdown.js');
  const block = '```chart\n{"type": "function", "title": "Parabola", "functions": [{"expr": "x^2", "from": -3, "to": 3}]}\n```';
  const done = String(markdown(`Here it is:\n\n${block}`).value ?? markdown(`Here it is:\n\n${block}`));
  assert.match(done, /<figure class="chart"><svg/);
  assert.match(done, /data-chart-action="copy"/);
  const streaming = String(markdown('```chart\n{"type": "func', { streaming: true }).value ?? '');
  assert.match(streaming, /Drawing the graph/);
  const code = String(markdown('```js\nconst a = 1;\n```').value ?? '');
  assert.match(code, /<pre data-lang="js">/, 'other code stays code');
});
