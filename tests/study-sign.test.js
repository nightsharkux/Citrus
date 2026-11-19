'use strict';
/**
 * The study sign: a full-screen "please do not disturb". The sign is a small plain object that is checked wherever it
 * comes from (stored settings, or a design from the assistant), so it can only ever be known values and readable colours.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const design = require('../src/modules/sign/design');

const model = () => import('../public/js/features/sign-model.js');

test('the four ready-made styles are readable and the message follows the language', async () => {
  const m = await model();
  assert.deepEqual(m.PRESETS.map((p) => p.id), ['black-white', 'black-red', 'red', 'flash-red']);
  for (const p of m.PRESETS) {
    const spec = m.normalizeSpec({ preset: p.id });
    assert.equal(spec.background, p.spec.background);
    assert.equal(spec.color, p.spec.color, `${p.id} keeps its own text colour: it can be read`);
    assert.ok(m.contrastRatio(spec.background, spec.color) >= 4.5, `${p.id} contrast`);
  }
  assert.equal(m.normalizeSpec({ preset: 'flash-red' }).style, 'flash');
  assert.equal(m.normalizeSpec({ preset: 'black-red' }).style, 'solid');

  const base = m.normalizeSpec({});
  assert.deepEqual(m.messageLines({ ...base, language: 'en' }), ['Please do not disturb']);
  assert.deepEqual(m.messageLines({ ...base, language: 'de' }), ['Bitte nicht stören']);
  assert.deepEqual(m.messageLines({ ...base, language: 'both' }), ['Please do not disturb', 'Bitte nicht stören']);
  assert.deepEqual(m.messageLines({ ...base, language: 'both', message: 'Exam tomorrow' }), ['Exam tomorrow'], 'their own message replaces the standard one');
  assert.equal(m.normalizeSpec({}, { language: 'de' }).language, 'de', 'a German app starts with a German sign');
});

test('anything stored is made safe: known values, readable colours, short text', async () => {
  const m = await model();
  const bad = m.normalizeSpec({ background: 'red; background:url(x)', color: 'javascript:alert(1)', style: 'strobe', size: '999', symbol: '<img>', speed: 'insane', language: 'fr', message: `  ${'x'.repeat(500)}  `, sub: '<script>alert(1)</script>' });
  assert.match(bad.background, /^#[0-9a-f]{6}$/);
  assert.match(bad.color, /^#[0-9a-f]{6}$/);
  assert.equal(bad.style, 'solid');
  assert.deepEqual([bad.size, bad.symbol, bad.speed, bad.language], ['l', 'none', 'slow', 'en']);
  assert.equal(bad.message.length, m.LIMITS.message);
  assert.equal(bad.sub, '<script>alert(1)</script>', 'text stays text: the page shows it escaped');
  assert.equal(m.hex('#ABC', null), '#aabbcc');
  assert.equal(m.hex('#12345', 'fallback'), 'fallback');
  assert.deepEqual(m.normalizeSpec(null), m.normalizeSpec({}));
  assert.deepEqual(m.normalizeSpec('nonsense'), m.normalizeSpec({}));

  // Text that cannot be read on its background is replaced by white or black.
  const grey = m.normalizeSpec({ background: '#777777', color: '#808080' });
  assert.ok(m.contrastRatio(grey.background, grey.color) >= 4.5);
  assert.equal(m.readableText('#ffffff', '#ffff00'), '#000000', 'yellow on white becomes black');
  // A flashing sign must stay readable at its dimmest too.
  const flash = m.normalizeSpec({ style: 'flash', background: '#202020', color: '#555555' });
  assert.ok(m.contrastRatio(m.dimmed(flash.background), flash.color) >= 4.5);
});

test('flashing is a slow pulse, never faster than once a second', async () => {
  const m = await model();
  for (const [speed, seconds] of Object.entries(m.SPEEDS)) {
    assert.ok(seconds >= 1, `${speed}: ${seconds} s a pulse is at most one flash a second, far under the three a second people are warned about`);
  }
  assert.equal(m.pulseSeconds({ speed: 'fast' }), 1);
  assert.equal(m.pulseSeconds({ speed: 'unknown' }), m.SPEEDS.slow);
  const kept = m.withPreset(m.normalizeSpec({ message: 'Back at 3', sub: 'Exam week', symbol: 'moon', preset: 'red', size: 'xl' }), 'flash-red');
  assert.deepEqual([kept.style, kept.message, kept.sub, kept.symbol, kept.size], ['flash', 'Back at 3', 'Exam week', 'moon', 'xl'], 'choosing a style keeps the person\'s own words');
});

test('the browser and the server agree on what a sign may contain', async () => {
  const m = await model();
  assert.deepEqual(design.SYMBOLS, m.SYMBOLS);
  assert.deepEqual(design.SIZES, Object.keys(m.SIZES));
  assert.deepEqual(design.SPEEDS, Object.keys(m.SPEEDS));
  assert.deepEqual(design.LANGUAGES, m.LANGUAGES);
  assert.deepEqual(design.LIMITS, m.LIMITS);
  // The same reply gives the same sign on both sides.
  const reply = JSON.stringify({ background: '#123456', color: '#f0f0f0', style: 'flash', message: 'Shh', language: 'de', size: 'xl', symbol: 'book', speed: 'normal', sub: 'Back at 15:30' });
  assert.deepEqual(design.sanitizeDesign(reply), m.normalizeSpec(JSON.parse(reply)));
});

test('a design from the assistant is read as data and only safe values get through', () => {
  const good = design.sanitizeDesign('Here you go:\n```json\n{"background":"#0b2545","color":"#ffffff","style":"solid","message":"Ruhe bitte","language":"de","sub":"","size":"xl","symbol":"book","speed":"slow"}\n```');
  assert.deepEqual(good, { preset: 'custom', style: 'solid', background: '#0b2545', color: '#ffffff', message: 'Ruhe bitte', language: 'de', sub: '', size: 'xl', symbol: 'book', speed: 'slow' });

  assert.equal(design.sanitizeDesign('I cannot do that'), null, 'no JSON');
  assert.equal(design.sanitizeDesign('{"message": "no colours"}'), null, 'no usable colours is not a design');
  assert.equal(design.sanitizeDesign('{broken'), null);
  assert.equal(design.sanitizeDesign('[1,2]'), null, 'a list is not a design');

  const hostile = design.sanitizeDesign(JSON.stringify({ background: 'url(javascript:x)', color: '#fff', message: 'Quiet' }));
  assert.equal(hostile, null, 'a colour that is not a hex colour is refused');
  const odd = design.sanitizeDesign(JSON.stringify({ background: '#ffffff', color: '#fefefe', style: 'blink', size: 'huge', symbol: 'skull', speed: 'ludicrous', language: 'fr', message: '<b onclick=x>Hi</b>'.repeat(20) }));
  assert.equal(odd.color, '#000000', 'near-white on white is replaced by black');
  assert.deepEqual([odd.style, odd.size, odd.symbol, odd.speed, odd.language], ['solid', 'l', 'none', 'slow', 'en']);
  assert.ok(odd.message.length <= 80);
  assert.ok(design.contrastRatio(odd.background, odd.color) >= 4.5);
  assert.equal(design.sanitizeDesign('{"background":"#d71920","color":"#d71920","style":"flash"}').color, '#ffffff', 'red text on red is fixed');
});

function gateway(reply) {
  const state = { calls: [] };
  return {
    state,
    async fetchImpl(url, options) {
      state.calls.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: typeof reply === 'function' ? reply(state.calls.length) : reply } }] });
    },
  };
}

test('Citrus designs a sign: signed-in only, needs the assistant, and the reply is checked', async () => {
  const off = await startApp();
  try {
    assert.equal((await off.call(null, 'POST', '/api/sign/design', { prompt: 'a calm blue sign' })).status, 401, 'signed out');
    await off.register('ann');
    const unavailable = await off.call('ann', 'POST', '/api/sign/design', { prompt: 'a calm blue sign' });
    assert.equal(unavailable.status, 503, 'without the assistant it says so');
    assert.match(unavailable.body.error, /not connected/i);
    assert.equal((await off.call('ann', 'POST', '/api/sign/design', { prompt: 'x' })).status, 400, 'too short');
  } finally {
    await off.close();
  }

  const fixture = gateway((n) => (n === 1
    ? '{"background":"#0b2545","color":"#8da9c4","style":"solid","message":"Quiet please","language":"en","size":"l","symbol":"moon","speed":"slow"}'
    : 'Sorry, I cannot design that.'));
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: fixture.fetchImpl });
  try {
    await app.register('ann');
    const made = await app.call('ann', 'POST', '/api/sign/design', { prompt: 'A calm blue sign for the library' });
    assert.equal(made.status, 200);
    assert.equal(made.body.design.message, 'Quiet please');
    assert.equal(made.body.design.symbol, 'moon');
    assert.ok(design.contrastRatio(made.body.design.background, made.body.design.color) >= 4.5, 'readable, whatever the model chose');
    // What the model was told: the rules, and the request as data.
    const sent = fixture.state.calls[0].messages.map((m) => m.content).join('\n');
    assert.match(sent, /never faster|"slow" unless/i);
    assert.match(sent, /<REQUEST>\nA calm blue sign for the library\n<\/REQUEST>/);

    const broken = await app.call('ann', 'POST', '/api/sign/design', { prompt: 'something else entirely' });
    assert.equal(broken.status, 503, 'a reply that is not a design is not passed on');
    assert.match(broken.body.error, /could not design/i);
  } finally {
    await app.close();
  }
});

test('designing is rate limited, and the sign is in All tools', async () => {
  const fixture = gateway('{"background":"#000000","color":"#ffffff"}');
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: fixture.fetchImpl });
  try {
    await app.register('ann');
    let last;
    for (let i = 0; i < 9; i += 1) last = await app.call('ann', 'POST', '/api/sign/design', { prompt: `design number ${i}` });
    assert.equal(last.status, 429);
    assert.equal(fixture.state.calls.length, 8, 'the ninth never reached the model');

    const tools = await app.call('ann', 'GET', '/api/v1/capabilities');
    const item = tools.body.groups.flatMap((g) => g.items).find((i) => i.id === 'study-sign');
    assert.deepEqual([item.status, item.route], ['available', '/sign']);
  } finally {
    await app.close();
  }
});
