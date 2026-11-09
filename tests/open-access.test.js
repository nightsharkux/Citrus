'use strict';
/** Lecturers make their own courses, students join courses and open spaces freely, and administrators can still require approval. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

test('a lecturer registers, makes a course and teaches it without an administrator', async () => {
  const app = await startApp();
  try {
    const reg = await app.register('prof', { role: 'lecturer' });
    assert.equal(reg.body.user.role, 'lecturer', 'active straight away');
    assert.equal(reg.body.user.requested_role, null);

    const made = await app.call('prof', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ml101' });
    assert.equal(made.status, 201);
    assert.equal((await app.call('prof', 'POST', '/api/courses', { title: 'Another', code: 'ML101' })).status, 409, 'codes are unique');

    const mine = (await app.call('prof', 'GET', '/api/courses')).body.courses;
    assert.deepEqual(mine.map((c) => [c.code, c.lecturer]), [['ML101', 'Prof Person']]);

    // Students join on their own; only lecturers and administrators make courses.
    await app.register('stu');
    assert.equal((await app.call('stu', 'POST', '/api/courses', { title: 'Mine', code: 'X1' })).status, 403);
    assert.equal((await app.call('stu', 'POST', `/api/courses/${made.body.id}/enroll`)).status, 200);
    assert.equal((await app.call('stu', 'GET', `/api/courses/${made.body.id}`)).status, 200);

    // The lecturer edits their own course and starts a live lecture in it; another lecturer cannot touch it.
    assert.equal((await app.call('prof', 'PATCH', `/api/courses/${made.body.id}`, { title: 'Machine Learning I' })).status, 200);
    const live = await app.call('prof', 'POST', '/api/live/sessions', { course_id: made.body.id });
    assert.equal(live.status, 201);
    await app.register('prof2', { role: 'lecturer' });
    assert.equal((await app.call('prof2', 'PATCH', `/api/courses/${made.body.id}`, { title: 'Hijacked' })).status, 404);
    assert.equal((await app.call('prof2', 'POST', '/api/live/sessions', { course_id: made.body.id })).status, 403);
    assert.equal((await app.call('anon', 'POST', '/api/courses', { title: 'Nope', code: 'N1' })).status, 401);
  } finally {
    await app.close();
  }
});

test('an administrator can switch lecturer approval back on', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const on = await app.call('admin', 'PATCH', '/api/admin/settings', { lecturerApproval: true });
    assert.equal(on.body.lecturerApproval ?? on.body.settings?.lecturerApproval, true);
    const reg = await app.register('prof', { role: 'lecturer' });
    assert.equal(reg.body.user.role, 'student', 'waits for approval');
    assert.equal(reg.body.user.requested_role, 'lecturer');
    assert.equal((await app.call('prof', 'POST', '/api/courses', { title: 'Too early', code: 'T1' })).status, 403);
    assert.equal((await app.call('stu_none', 'PATCH', '/api/admin/settings', { lecturerApproval: false })).status, 401);
    await app.register('stu');
    assert.equal((await app.call('stu', 'PATCH', '/api/admin/settings', { lecturerApproval: false })).status, 403, 'only administrators change it');
  } finally {
    await app.close();
  }
});

test('open spaces can be browsed and joined without a code; private ones cannot', async () => {
  const app = await startApp();
  try {
    await app.register('ann');
    await app.register('ben');
    await app.register('cem');
    const open = await app.call('ann', 'POST', '/api/workspaces', { title: 'Exam prep group', kind: 'study', open: true });
    const closed = await app.call('ann', 'POST', '/api/workspaces', { title: 'Private notes', kind: 'study' });
    assert.equal(open.status, 201);

    const found = (await app.call('ben', 'GET', '/api/workspaces/open')).body.rooms;
    assert.deepEqual(found.map((r) => r.title), ['Exam prep group'], 'only open spaces are listed');
    assert.equal((await app.call('ben', 'GET', '/api/workspaces/open?q=exam')).body.rooms.length, 1);
    assert.equal((await app.call('ben', 'GET', '/api/workspaces/open?q=zzz')).body.rooms.length, 0);
    assert.equal(found[0].joinCode, undefined, 'the invite code is not exposed');

    assert.equal((await app.call('ben', 'GET', `/api/workspaces/${open.body.id}`)).status, 403, 'not a member yet');
    assert.equal((await app.call('ben', 'POST', `/api/workspaces/${closed.body.id}/join-open`)).status, 404);
    assert.equal((await app.call('ben', 'POST', `/api/workspaces/${open.body.id}/join-open`)).status, 200);
    assert.equal((await app.call('ben', 'GET', `/api/workspaces/${open.body.id}`)).status, 200);
    assert.equal((await app.call('ben', 'GET', '/api/workspaces/open')).body.rooms.length, 0, 'joined spaces leave the list');

    // Only the creator opens or closes it; closing keeps existing members.
    assert.equal((await app.call('cem', 'POST', `/api/workspaces/${open.body.id}/open`, { open: false })).status, 403);
    assert.equal((await app.call('ann', 'POST', `/api/workspaces/${open.body.id}/open`, { open: false })).status, 200);
    assert.equal((await app.call('cem', 'POST', `/api/workspaces/${open.body.id}/join-open`)).status, 404);
    assert.equal((await app.call('ben', 'GET', `/api/workspaces/${open.body.id}`)).status, 200);
    assert.equal((await app.call('anon', 'GET', '/api/workspaces/open')).status, 401);
  } finally {
    await app.close();
  }
});
