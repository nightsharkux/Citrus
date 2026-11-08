'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { startApp } = require('./helpers');

test('configuration check reads saved provider choices without claiming a live connection', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  app.db.run('INSERT INTO institution_ai_settings(institution_id, provider, updated) VALUES(1, ?, ?)', 'gateway', new Date().toISOString());
  const env = { ...process.env, DB_PATH: app.config.dbPath, CAMPUS_AI_PROVIDER: 'off', AI_GATEWAY_API_KEY: 'fixture-gateway-key' };
  const script = path.join(__dirname, '../scripts/check.js');
  const configured = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(configured.status, 0, configured.stdout + configured.stderr);
  assert.match(configured.stdout, /Institution 1: gateway/);
  assert.match(configured.stdout, /connection untested/);
  assert.match(configured.stdout, /0 knowledge entries/);
  assert.doesNotMatch(configured.stdout, /answered a live request/);
  assert.equal(app.db.get('SELECT provider FROM institution_ai_settings').provider, 'gateway');
  app.db.run("UPDATE institution_ai_settings SET provider = 'off'");
  const disabled = spawnSync(process.execPath, [script, '--ai'], { env, encoding: 'utf8' });
  assert.equal(disabled.status, 1, disabled.stdout + disabled.stderr);
  assert.match(disabled.stdout, /select a configured provider before testing AI/);
});
