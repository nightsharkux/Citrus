'use strict';
/** Device gateway: signed requests, replay protection, door lights, NFC pairing, tap-to-confirm sessions. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { signedHeaders } = require('../src/modules/devices/protocol');

function device(app, creds) {
  return async (path, body = {}, { tamper, reuse } = {}) => {
    const raw = JSON.stringify(body);
    const fullPath = `/api/v1/device/${path}`;
    const headers = reuse || signedHeaders({ deviceId: creds.deviceId, secret: creds.secret, method: 'POST', path: fullPath, body: raw });
    if (tamper) headers['X-Device-Signature'] = '0'.repeat(64);
    const res = await fetch(app.base + fullPath, { method: 'POST', headers, body: raw });
    return { status: res.status, body: await res.json(), headers };
  };
}

test('device gateway end to end', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const lecturerId = await app.lecturer('lec');
    await app.call('admin', 'POST', '/api/admin/assign', { course_id: 1, lecturer_id: lecturerId });
    const stu = await app.register('stu');
    await app.call('stu', 'POST', '/api/courses/1/enroll');

    assert.equal((await app.call('lec', 'POST', '/api/devices', { name: 'x', kind: 'puck' })).status, 403, 'only admins register devices');
    const reg = await app.call('admin', 'POST', '/api/devices', { name: 'MF2 puck', kind: 'puck', room: 'MF2' });
    assert.equal(reg.status, 201);
    const creds = reg.body.credentials;
    assert.match(creds.deviceId, /^dev_\d+$/);
    assert.ok(!JSON.stringify(app.db.prepare('SELECT secret FROM devices').get()).includes(creds.secret), 'secret is encrypted at rest');
    const send = device(app, creds);

    // Authentication
    const hb = await send('heartbeat', { firmware: 'test-1', capabilities: ['nfc', 'speaker'] });
    assert.equal(hb.status, 200);
    assert.equal(hb.body.device.room, 'MF2');
    assert.equal((await send('heartbeat', {}, { tamper: true })).status, 401, 'bad signature');
    assert.equal((await send('heartbeat', {}, { reuse: hb.headers })).status, 401, 'replayed nonce');
    const stale = signedHeaders({ deviceId: creds.deviceId, secret: creds.secret, method: 'POST', path: '/api/v1/device/heartbeat', body: '{}' });
    stale['X-Device-Timestamp'] = String(Date.now() - 10 * 60_000);
    assert.equal((await send('heartbeat', {}, { reuse: stale })).status, 401, 'stale timestamp');

    // Room status set in the app reaches the device (door light).
    await app.call('lec', 'POST', '/api/notices', { room: 'MF2', status: 'do_not_disturb', note: 'Exam' });
    const cmds = (await send('heartbeat')).body.commands;
    assert.equal(cmds[0].type, 'room.status');
    assert.equal(cmds[0].payload.status, 'do_not_disturb');
    assert.equal((await send(`commands/${cmds[0].id}/ack`, { result: 'ok' })).status, 200);

    // Unknown card does nothing.
    assert.equal((await send('events', { type: 'nfc.tap', data: { uid: '04AABBCCDD' } })).body.result, 'unknown_card');

    // Pair the lecturer's card via the reader (consent required).
    assert.equal((await app.call('lec', 'POST', `/api/devices/${reg.body.device.id}/pair`, { user_id: lecturerId })).status, 400);
    assert.equal((await app.call('lec', 'POST', `/api/devices/${reg.body.device.id}/pair`, { user_id: lecturerId, consent: true })).status, 200);
    assert.equal((await send('events', { type: 'nfc.tap', data: { uid: '04-11-22-33-44' } })).body.result, 'paired');
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM cx_nfc_bindings WHERE uid_digest LIKE '%0411%'").get().n, 0, 'raw UID never stored');

    // Lecturer tap → pending activation (nothing starts yet).
    const tap = await send('events', { type: 'nfc.tap', data: { uid: '0411223344' } });
    assert.equal(tap.body.result, 'activation_pending');
    assert.equal((await send('events', { type: 'voice.query', data: { text: 'Hello?' } })).body.result, 'inactive', 'voice needs a confirmed session');
    const pending = (await app.call('lec', 'GET', '/api/activations')).body.activations;
    assert.equal(pending[0].status, 'pending');
    assert.equal((await app.call('stu', 'GET', '/api/activations')).status, 403);

    // Confirm in the app → participation session with live code + room status + device command.
    const confirm = await app.call('lec', 'POST', `/api/activations/${pending[0].id}`, { decision: 'confirm', course_id: 1, room_status: 'quiet' });
    assert.equal(confirm.status, 200);
    assert.ok(confirm.body.sessionId);
    const types = (await send('heartbeat')).body.commands.map((c) => c.type);
    assert.ok(types.includes('session.started') && types.includes('room.status'));
    const session = (await app.call('lec', 'GET', `/api/participation/${confirm.body.sessionId}`)).body.session;
    assert.equal(session.room, 'MF2');
    assert.equal(session.require_code, true);

    // Student card linked manually, then tapped on the reader → checked in.
    await app.call('lec', 'POST', `/api/participation/${confirm.body.sessionId}/nfc/bind`, { user_id: stu.body.user.id, card_uid: 'A1B2C3D4', confirm_student_consent: true });
    assert.equal((await send('events', { type: 'nfc.tap', data: { uid: 'A1B2C3D4' } })).body.result, 'checked_in');
    const roster = (await app.call('lec', 'GET', `/api/participation/${confirm.body.sessionId}`)).body.people;
    assert.equal(roster.find((p) => p.id === stu.body.user.id).method, 'nfc_device');

    // End button closes the session and reopens the room.
    assert.equal((await send('events', { type: 'button.press', data: { button: 'end' } })).body.result, 'session_ended');
    assert.equal((await app.call('lec', 'GET', `/api/participation/${confirm.body.sessionId}`)).body.session.open, false);

    // Revocation is immediate.
    await app.call('admin', 'DELETE', `/api/devices/${reg.body.device.id}`);
    assert.equal((await send('heartbeat')).status, 401);
  } finally {
    await app.close();
  }
});

test('heartbeat long-poll returns as soon as a command is queued', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const reg = await app.call('admin', 'POST', '/api/devices', { name: 'Door', kind: 'door_light', room: 'A101' });
    const send = device(app, reg.body.credentials);
    await send('heartbeat');
    const started = Date.now();
    const waiting = send('heartbeat', { wait: 20 });
    setTimeout(() => app.call('admin', 'POST', '/api/notices', { room: 'A101', status: 'consultation' }), 200);
    const r = await waiting;
    assert.equal(r.body.commands[0].payload.status, 'consultation');
    assert.ok(Date.now() - started < 5000, 'returned early');
  } finally {
    await app.close();
  }
});
