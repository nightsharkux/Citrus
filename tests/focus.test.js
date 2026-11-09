'use strict';
/** Campus Focus: "do not disturb until". Non-urgent notifications wait quietly in the inbox; urgent ones still get through. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

test('Focus pauses non-urgent notifications and pushes, expires, and can be turned off', async () => {
  const app = await startApp();
  try {
    const me = await app.register('stu');
    const userId = me.body.user.id;
    const { notifier } = app.app.deps;

    const inOneHour = new Date(Date.now() + 3600_000).toISOString();
    const saved = await app.call('stu', 'PATCH', '/api/me', { preferences: { focusUntil: inOneHour } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.user.preferences.focusUntil, inOneHour);
    assert.equal(notifier.focused(userId), true);

    notifier.notify(userId, { kind: 'course', title: 'Lecture moved' });
    notifier.notify(userId, { kind: 'device', title: 'You tapped in', urgent: true });
    const inbox = (await app.call('stu', 'GET', '/api/notifications')).body;
    assert.equal((inbox.notifications || inbox.items || []).length, 2, 'both are in the inbox: Focus only makes them quiet');

    // Validation: a past time turns it off, more than 12 hours is refused, nonsense is refused.
    assert.equal((await app.call('stu', 'PATCH', '/api/me', { preferences: { focusUntil: new Date(Date.now() + 13 * 3600_000).toISOString() } })).status, 400);
    assert.equal((await app.call('stu', 'PATCH', '/api/me', { preferences: { focusUntil: 'soon' } })).status, 400);
    const past = await app.call('stu', 'PATCH', '/api/me', { preferences: { focusUntil: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(past.body.user.preferences.focusUntil, undefined, 'a time already past is off');
    assert.equal(notifier.focused(userId), false);

    await app.call('stu', 'PATCH', '/api/me', { preferences: { focusUntil: inOneHour } });
    assert.equal((await app.call('stu', 'PATCH', '/api/me', { preferences: { focusUntil: null } })).body.user.preferences.focusUntil, undefined);
    assert.equal(notifier.focused(userId), false);
    assert.equal((await app.call('anon', 'PATCH', '/api/me', { preferences: { focusUntil: inOneHour } })).status, 401);
  } finally {
    await app.close();
  }
});

test('Focus only affects the person who turned it on', async () => {
  const app = await startApp();
  try {
    const a = await app.register('alice');
    const b = await app.register('bob');
    await app.call('alice', 'PATCH', '/api/me', { preferences: { focusUntil: new Date(Date.now() + 3600_000).toISOString() } });
    assert.equal(app.app.deps.notifier.focused(a.body.user.id), true);
    assert.equal(app.app.deps.notifier.focused(b.body.user.id), false);
  } finally {
    await app.close();
  }
});
