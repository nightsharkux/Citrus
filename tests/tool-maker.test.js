'use strict';
/** Make a tool / More tools: made by the AI, private by default, shared after review, and run locked down. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { readTool } = require('../src/modules/apps/routes');
const { cleanToolHtml, TOOL_CSP } = require('../src/modules/apps/frame');

const CLOCK = '<div class="tool"><div class="big" id="t"></div><p class="muted" id="d"></p></div><script>const t=document.getElementById("t");setInterval(()=>{t.textContent=new Date().toLocaleTimeString()},1000)</script>';

function gateway(reply) {
  return async () => Response.json({ choices: [{ message: { content: reply } }] });
}

test('tool code is cleaned and the page is locked down', () => {
  assert.equal(cleanToolHtml('<iframe src="https://x"></iframe><script src="https://evil"></script><b>ok</b>'), '<b>ok</b>');
  assert.match(TOOL_CSP, /connect-src 'none'/);
  assert.match(TOOL_CSP, /sandbox allow-scripts/);
  assert.doesNotMatch(TOOL_CSP, /allow-same-origin/);
  assert.equal(readTool('{"refused": "It collects passwords."}').refused, 'It collects passwords.');
  assert.equal(readTool('nonsense'), null);
  assert.equal(readTool(JSON.stringify({ name: 'Clock', icon: 'not-an-icon', html: CLOCK })).icon, 'layers');
});

test('a tool is made, given a look, shared after review and added by others', async () => {
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: gateway(JSON.stringify({ name: 'Big clock', description: 'The time, big enough for the back row.', icon: 'clock', html: CLOCK })) });
  try {
    await app.login('admin');
    await app.register('ann');
    await app.register('ben');
    const made = await app.call('ann', 'POST', '/api/apps', { idea: 'A big clock for the projector' });
    assert.equal(made.status, 201);
    const t = made.body.tool;
    assert.deepEqual([t.name, t.icon, t.visibility, t.look], ['Big clock', 'clock', 'private', 'glass']);

    // Private: only its maker sees it.
    assert.equal((await app.call('ben', 'GET', `/api/apps/${t.id}`)).status, 403);
    assert.equal((await app.call('ben', 'GET', `/api/apps/${t.id}/frame`)).status, 403);
    assert.equal((await app.call('ben', 'PATCH', `/api/apps/${t.id}`, { look: 'night' })).status, 403);

    // It runs locked down, in the look chosen.
    assert.equal((await app.call('ann', 'PATCH', `/api/apps/${t.id}`, { look: 'night' })).body.tool.look, 'night');
    const frame = await app.call('ann', 'GET', `/api/apps/${t.id}/frame`, undefined, { raw: true });
    assert.equal(frame.status, 200);
    assert.match(frame.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.match(frame.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.equal(frame.headers.get('x-frame-options'), 'SAMEORIGIN');
    const page = await frame.text();
    assert.match(page, /data-look="night"/);
    assert.match(page, /class="big"/);
    const bold = await app.call('ann', 'GET', `/api/apps/${t.id}/frame?look=bold`, undefined, { raw: true });
    assert.match(await bold.text(), /data-look="bold"/, 'previews of the other looks');

    // Sharing waits for an administrator.
    assert.equal((await app.call('ann', 'POST', `/api/apps/${t.id}/share`)).body.tool.visibility, 'pending');
    assert.equal((await app.call('ben', 'GET', '/api/apps/gallery')).body.tools.length, 0);
    assert.equal((await app.call('ben', 'POST', `/api/apps/${t.id}/review`, { decision: 'approve' })).status, 403);
    assert.equal((await app.call('admin', 'GET', '/api/apps/gallery')).body.waiting.length, 1);
    await app.call('admin', 'POST', `/api/apps/${t.id}/review`, { decision: 'approve' });
    const gallery = await app.call('ben', 'GET', '/api/apps/gallery');
    assert.equal(gallery.body.tools[0].maker, 'Ann Person');
    assert.equal((await app.call('ben', 'POST', `/api/apps/${t.id}/add`)).status, 200);
    assert.equal((await app.call('ben', 'GET', '/api/apps')).body.added[0].name, 'Big clock');
    assert.equal((await app.call('ben', 'GET', `/api/apps/${t.id}/frame`)).status, 200, 'shared tools run for everyone');
    assert.equal((await app.call('ben', 'DELETE', `/api/apps/${t.id}`)).status, 403);

    // Changing a shared tool sends it back to review.
    const changed = await app.call('ann', 'POST', `/api/apps/${t.id}/change`, { change: 'Show the date as well' });
    assert.equal(changed.body.tool.visibility, 'pending');
    assert.equal((await app.call('ben', 'GET', `/api/apps/${t.id}/frame`)).status, 403);
  } finally {
    await app.close();
  }
});

test('ideas outside the guidelines are refused', async () => {
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: gateway('{"refused": "It would collect other students’ passwords."}') });
  try {
    await app.register('ann');
    const r = await app.call('ann', 'POST', '/api/apps', { idea: 'A fake login page that saves passwords' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /make this tool/);
    assert.equal((await app.call('ann', 'GET', '/api/apps')).body.mine.length, 0);
  } finally {
    await app.close();
  }
});
