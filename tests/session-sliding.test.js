'use strict';
/** A signed-in person stays signed in while they use the app. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

test('using the app pushes the end of the session forward and renews the cookie', async () => {
  const app = await startApp();
  try {
    await app.register('stu');
    const before = app.db.get('SELECT token, expires FROM sessions ORDER BY created DESC LIMIT 1');
    // Pretend the session was last touched ten minutes ago and is close to its end.
    app.db.run('UPDATE sessions SET last_seen = ?, expires = ? WHERE token = ?', Date.now() - 600_000, Date.now() + 60_000, before.token);
    const res = await app.call('stu', 'GET', '/api/me');
    assert.equal(res.status, 200);
    // Renewing the session is written in the background (nobody waits for it), so give it a moment to land.
    let after;
    for (let i = 0; i < 40; i += 1) {
      after = app.db.get('SELECT expires FROM sessions WHERE token = ?', before.token);
      if (after.expires > Date.now() + 20 * 86_400_000) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(after.expires > Date.now() + 20 * 86_400_000, 'the session now lasts weeks again');
    assert.match(res.headers.get('set-cookie') || '', /Max-Age=\d{6,}/, 'the browser cookie is renewed too');
  } finally {
    await app.close();
  }
});
