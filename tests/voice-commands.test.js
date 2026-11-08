'use strict';
/** Spoken commands that run without the AI: precise enough that questions still reach the assistant. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);

function harness(role = 'student') {
  const calls = [];
  return {
    calls,
    ctx: { role, navigate: (p) => calls.push(['go', p]), setTheme: (m) => calls.push(['theme', m]), stop: () => calls.push(['stop']), stopListening: () => calls.push(['sleep']) },
  };
}

test('page, theme, stop and new-chat commands run locally', async () => {
  const { matchCommand } = await load('features/commands.js');
  const run = (text, role) => {
    const h = harness(role);
    const c = matchCommand(text, h.ctx);
    c?.run();
    return c ? h.calls : null;
  };
  assert.deepEqual(run('Open schedule.'), [['go', '/schedule']]);
  assert.deepEqual(run('Please go to my calendar'), [['go', '/schedule']]);
  assert.deepEqual(run('could you show me the inbox'), [['go', '/inbox']]);
  assert.deepEqual(run('take me to campus life'), [['go', '/campus']]);
  assert.deepEqual(run('open the all tools page'), [['go', '/tools']]);
  assert.deepEqual(run('Dark mode'), [['theme', 'dark']]);
  assert.deepEqual(run('switch to light mode'), [['theme', 'light']]);
  assert.deepEqual(run('stop'), [['stop']]);
  assert.deepEqual(run('stop listening'), [['sleep']]);
  assert.deepEqual(run('new conversation'), [['go', '/assistant?new=1']]);
});

test('questions and requests with details are left for the assistant', async () => {
  const { matchCommand } = await load('features/commands.js');
  const h = harness();
  for (const text of ['show me what is on my calendar tomorrow', 'open the library opening hours', 'go to sleep at ten', 'what is dark matter', 'add a study session tomorrow at four', 'stop the semester clock from ticking']) {
    assert.equal(matchCommand(text, h.ctx), null, text);
  }
});

test('pages the role cannot see are not opened by voice', async () => {
  const { matchCommand } = await load('features/commands.js');
  const h = harness('student');
  assert.equal(matchCommand('open people', h.ctx), null);
  assert.equal(matchCommand('open moderation', h.ctx), null);
  assert.ok(matchCommand('open people', harness('admin').ctx));
});
