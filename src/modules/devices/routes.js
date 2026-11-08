'use strict';
/**
 * Classroom device gateway.
 *
 * Admin API      register, list, rotate, revoke devices and send test commands.
 * Device API     signed requests from hardware: heartbeat (+ commands) and events.
 * Activation API a lecturer taps their card on a reader/puck, then confirms in
 *                the app. A card UID alone never signs anyone in.
 *
 * See docs/HARDWARE.md for the wire protocol and hardware/ for reference clients.
 */
const { randomToken, hmac } = require('../../lib/crypto');
const { text, oneOf, id, optionalId, clamp } = require('../../lib/validate');
const { badRequest, forbidden, notFound, unauthorized, tooMany } = require('../../http/errors');
const { createRateLimiter } = require('../../http/rate-limit');
const protocol = require('./protocol');
const { voicePrompt } = require('../../ai/prompts');

const KINDS = ['puck', 'nfc_reader', 'door_light', 'display'];
const ONLINE_MS = 90_000;
const ACTIVATION_MS = 2 * 60_000;
const ADMIN_COMMANDS = ['display.message', 'speak', 'ping', 'room.status'];

function register(router, deps) {
  const { db, ai, bus, notifier, audit, access, rooms, deviceCommands, participation, secretBox, nfcKey, site } = deps;
  const voiceLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
  const isoNow = () => new Date().toISOString();

  const deviceKey = (deviceId) => `dev_${deviceId}`;
  const parseDeviceKey = (value) => {
    const m = /^dev_(\d+)$/.exec(String(value || ''));
    return m ? Number(m[1]) : null;
  };

  /** Same digest scheme as manual pairing, so cards paired either way work everywhere. */
  function uidDigest(input) {
    const uid = clamp(input, 100).replace(/[^a-fA-F0-9]/g, '').toUpperCase();
    if (uid.length < 6 || uid.length > 32 || uid.length % 2) return null;
    return hmac(nfcKey, uid);
  }

  function shape(d, { full = false } = {}) {
    return {
      id: d.id,
      key: deviceKey(d.id),
      name: d.name,
      kind: d.kind,
      room: d.room,
      status: d.status,
      online: d.status === 'active' && !!d.last_seen && Date.now() - d.last_seen < ONLINE_MS,
      lastSeen: d.last_seen ? new Date(d.last_seen).toISOString() : null,
      ...(full ? { firmware: d.firmware, capabilities: JSON.parse(d.capabilities || '[]'), created: d.created } : {}),
    };
  }

  function deviceFor(user, deviceId) {
    const d = db.get('SELECT * FROM devices WHERE id = ? AND institution_id = ?', id(deviceId), user.institution_id);
    if (!d) throw notFound('Device not found');
    return d;
  }

  function logEvent(deviceId, type, summary = '') {
    db.run('INSERT INTO device_events(device_id, type, summary, created) VALUES(?, ?, ?, ?)', deviceId, type, String(summary).slice(0, 300), isoNow());
  }

  // ---------------------------------------------------------------- Admin API

  router.get('/api/devices', (ctx) => {
    const full = ctx.user.role === 'admin';
    const rows = full
      ? db.all('SELECT * FROM devices WHERE institution_id = ? ORDER BY status, room, name', ctx.user.institution_id)
      : db.all("SELECT * FROM devices WHERE institution_id = ? AND status = 'active' ORDER BY room, name", ctx.user.institution_id);
    return { devices: rows.map((d) => shape(d, { full })), kinds: KINDS };
  }, { roles: ['lecturer', 'admin'] });

  router.post('/api/devices', async (ctx) => {
    const b = await ctx.json();
    const name = text(b.name, { min: 2, max: 80, label: 'Device name' });
    const kind = oneOf(b.kind, KINDS, 'Device type');
    const room = text(b.room, { max: 80, optional: true, label: 'Room' });
    const secret = randomToken(32);
    const deviceId = db.insert(
      'INSERT INTO devices(institution_id, name, kind, room, secret, created_by, created) VALUES(?, ?, ?, ?, ?, ?, ?)',
      ctx.user.institution_id, name, kind, room, secretBox.seal(secret), ctx.user.id, isoNow(),
    );
    audit(ctx.user, 'device_registered', `${deviceKey(deviceId)} ${name}`);
    ctx.status = 201;
    return { device: shape(db.get('SELECT * FROM devices WHERE id = ?', deviceId), { full: true }), credentials: { deviceId: deviceKey(deviceId), secret } };
  }, { roles: ['admin'] });

  router.patch('/api/devices/:id', async (ctx) => {
    const d = deviceFor(ctx.user, ctx.params.id);
    const b = await ctx.json();
    const name = b.name !== undefined ? text(b.name, { min: 2, max: 80, label: 'Device name' }) : d.name;
    const room = b.room !== undefined ? text(b.room, { max: 80, optional: true, label: 'Room' }) : d.room;
    db.run('UPDATE devices SET name = ?, room = ? WHERE id = ?', name, room, d.id);
    audit(ctx.user, 'device_updated', deviceKey(d.id));
    return { device: shape(db.get('SELECT * FROM devices WHERE id = ?', d.id), { full: true }) };
  }, { roles: ['admin'] });

  router.post('/api/devices/:id/rotate', (ctx) => {
    const d = deviceFor(ctx.user, ctx.params.id);
    if (d.status !== 'active') throw badRequest('Revoked devices cannot be rotated');
    const secret = randomToken(32);
    db.run('UPDATE devices SET secret = ? WHERE id = ?', secretBox.seal(secret), d.id);
    audit(ctx.user, 'device_secret_rotated', deviceKey(d.id));
    return { credentials: { deviceId: deviceKey(d.id), secret } };
  }, { roles: ['admin'] });

  router.delete('/api/devices/:id', (ctx) => {
    const d = deviceFor(ctx.user, ctx.params.id);
    db.run("UPDATE devices SET status = 'revoked' WHERE id = ?", d.id);
    db.run("UPDATE device_activations SET status = 'ended', resolved = ? WHERE device_id = ? AND status IN ('pending','confirmed')", isoNow(), d.id);
    audit(ctx.user, 'device_revoked', deviceKey(d.id));
    return { ok: true };
  }, { roles: ['admin'] });

  router.post('/api/devices/:id/commands', async (ctx) => {
    const d = deviceFor(ctx.user, ctx.params.id);
    const b = await ctx.json();
    const type = oneOf(b.type, ADMIN_COMMANDS, 'Command');
    const payload = { text: clamp(b.text, 200) || 'Hello from Campus OS' };
    const commandId = deviceCommands.queue(d.id, type, type === 'room.status' ? { room: d.room, status: 'open', note: '' } : payload);
    return { id: commandId };
  }, { roles: ['admin'] });

  router.get('/api/devices/:id/events', (ctx) => {
    const d = deviceFor(ctx.user, ctx.params.id);
    return {
      events: db.all('SELECT type, summary, created FROM device_events WHERE device_id = ? ORDER BY id DESC LIMIT 50', d.id),
      commands: db.all('SELECT id, type, status, created, acked FROM device_commands WHERE device_id = ? ORDER BY id DESC LIMIT 20', d.id),
    };
  }, { roles: ['admin'] });

  /** Start NFC pairing: the next tap on this reader is bound to the chosen person. */
  router.post('/api/devices/:id/pair', async (ctx) => {
    const d = deviceFor(ctx.user, ctx.params.id);
    if (d.status !== 'active' || !['nfc_reader', 'puck'].includes(d.kind)) throw badRequest('Choose an active NFC reader or puck');
    const b = await ctx.json();
    const targetId = id(b.user_id, 'Person');
    if (b.consent !== true) throw badRequest('Confirm the person agreed to link their card');
    const target = db.get('SELECT id, name, role FROM users WHERE id = ? AND institution_id = ? AND deleted = 0', targetId, ctx.user.institution_id);
    if (!target) throw notFound('Person not found');
    if (ctx.user.role === 'lecturer' && target.id !== ctx.user.id) {
      const teaches = db.get('SELECT 1 FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = ? AND c.lecturer_id = ?', target.id, ctx.user.id);
      if (!teaches) throw forbidden('You can only pair yourself or students in your courses');
    }
    const expires = Date.now() + ACTIVATION_MS;
    db.run(
      'INSERT INTO nfc_pairings(device_id, user_id, requested_by, expires) VALUES(?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET user_id = excluded.user_id, requested_by = excluded.requested_by, expires = excluded.expires',
      d.id, target.id, ctx.user.id, expires,
    );
    deviceCommands.queue(d.id, 'nfc.pair', { name: target.name.split(' ')[0] });
    audit(ctx.user, 'nfc_pairing_started', `${deviceKey(d.id)} user ${target.id}`);
    return { expires: new Date(expires).toISOString() };
  }, { roles: ['lecturer', 'admin'] });

  // ------------------------------------------------------- Device-facing API

  async function authenticateDevice(ctx) {
    const h = ctx.req.headers;
    const deviceId = parseDeviceKey(h['x-device-id']);
    const timestamp = Number(h['x-device-timestamp']);
    const nonce = String(h['x-device-nonce'] || '');
    const raw = (await ctx.raw(64_000)).toString('utf8');
    if (!deviceId || !Number.isFinite(timestamp) || nonce.length < 16 || nonce.length > 64) throw unauthorized('Missing device signature');
    if (Math.abs(Date.now() - timestamp) > protocol.MAX_SKEW_MS) throw unauthorized('Device clock is out of sync');
    const device = db.get('SELECT * FROM devices WHERE id = ?', deviceId);
    if (!device || device.status !== 'active') throw unauthorized('Unknown or revoked device');
    const secret = secretBox.open(device.secret);
    const valid = protocol.verify(secret, { method: ctx.method, path: ctx.originalPath, timestamp, nonce, body: raw, signature: h['x-device-signature'] });
    if (!valid) throw unauthorized('Invalid device signature');
    const replay = db.run('INSERT OR IGNORE INTO device_nonces(device_id, nonce, seen) VALUES(?, ?, ?)', device.id, nonce, Date.now());
    if (!replay.changes) throw unauthorized('Replayed request');
    db.run('UPDATE devices SET last_seen = ? WHERE id = ?', Date.now(), device.id);
    let body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        throw badRequest('Invalid JSON');
      }
    }
    return { device, body };
  }

  router.post('/api/device/heartbeat', async (ctx) => {
    const { device, body } = await authenticateDevice(ctx);
    if (body.firmware || body.capabilities) {
      db.run(
        'UPDATE devices SET firmware = ?, capabilities = ? WHERE id = ?',
        clamp(body.firmware || device.firmware, 60),
        JSON.stringify(Array.isArray(body.capabilities) ? body.capabilities.map((c) => clamp(c, 30)).slice(0, 20) : JSON.parse(device.capabilities || '[]')),
        device.id,
      );
    }
    let commands = deviceCommands.take(device.id);
    const wait = Math.min(25_000, Math.max(0, Number(body.wait) || 0) * 1000);
    if (!commands.length && wait > 0) {
      await deviceCommands.waitFor(device.id, wait);
      commands = deviceCommands.take(device.id);
    }
    return {
      serverTime: isoNow(),
      device: { id: deviceKey(device.id), name: device.name, kind: device.kind, room: device.room },
      room: device.room ? rooms.get(device.institution_id, device.room) : null,
      activeSession: activeActivation(device.id) ? true : false,
      commands,
    };
  }, { auth: 'device' });

  router.post('/api/device/commands/:id/ack', async (ctx) => {
    const { device, body } = await authenticateDevice(ctx);
    if (!deviceCommands.ack(device.id, id(ctx.params.id), body.result)) throw notFound('Command not found');
    return { ok: true };
  }, { auth: 'device' });

  router.post('/api/device/events', async (ctx) => {
    const { device, body } = await authenticateDevice(ctx);
    const type = String(body.type || '');
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    switch (type) {
      case 'nfc.tap': return handleTap(device, data);
      case 'voice.query': return handleVoice(device, data);
      case 'button.press': return handleButton(device, data);
      case 'status':
        logEvent(device.id, 'status', clamp(JSON.stringify(data), 200));
        return { result: 'ok' };
      default:
        throw badRequest('Unknown event type');
    }
  }, { auth: 'device' });

  function activeActivation(deviceId) {
    return db.get(
      "SELECT * FROM device_activations WHERE device_id = ? AND status = 'confirmed' AND resolved > ? ORDER BY id DESC LIMIT 1",
      deviceId, new Date(Date.now() - 6 * 3_600_000).toISOString(),
    );
  }

  function handleTap(device, data) {
    const digest = uidDigest(data.uid);
    if (!digest) throw badRequest('Invalid card UID');

    const pairing = db.get('SELECT * FROM nfc_pairings WHERE device_id = ? AND expires > ?', device.id, Date.now());
    if (pairing) {
      const holder = db.get('SELECT user_id FROM cx_nfc_bindings WHERE institution_id = ? AND uid_digest = ?', device.institution_id, digest);
      if (holder && holder.user_id !== pairing.user_id) {
        logEvent(device.id, 'nfc.pair.rejected', 'Card already linked to someone else');
        deviceCommands.queue(device.id, 'display.message', { text: 'Card already linked' });
        return { result: 'pair_conflict' };
      }
      db.transaction(() => {
        db.run('DELETE FROM cx_nfc_bindings WHERE institution_id = ? AND user_id = ?', device.institution_id, pairing.user_id);
        db.run('INSERT INTO cx_nfc_bindings(institution_id, uid_digest, user_id, bound_by, created) VALUES(?, ?, ?, ?, ?)', device.institution_id, digest, pairing.user_id, pairing.requested_by, isoNow());
        db.run('DELETE FROM nfc_pairings WHERE device_id = ?', device.id);
      });
      const person = db.get('SELECT name FROM users WHERE id = ?', pairing.user_id);
      logEvent(device.id, 'nfc.paired', `user ${pairing.user_id}`);
      notifier.notify(pairing.requested_by, { kind: 'device', title: 'Card linked', body: `${person.name}'s card is now linked.`, link: '/classroom' });
      deviceCommands.queue(device.id, 'display.message', { text: `Linked: ${person.name.split(' ')[0]}` });
      return { result: 'paired', name: person.name.split(' ')[0] };
    }

    const binding = db.get(
      'SELECT u.id, u.name, u.role FROM cx_nfc_bindings b JOIN users u ON u.id = b.user_id WHERE b.institution_id = ? AND b.uid_digest = ? AND u.deleted = 0',
      device.institution_id, digest,
    );
    if (!binding) {
      logEvent(device.id, 'nfc.unknown', 'Unrecognised card');
      return { result: 'unknown_card' };
    }

    if (binding.role === 'lecturer' || binding.role === 'admin') {
      db.run("UPDATE device_activations SET status = 'expired' WHERE device_id = ? AND status = 'pending'", device.id);
      const activationId = db.insert(
        'INSERT INTO device_activations(institution_id, device_id, user_id, room, created, expires) VALUES(?, ?, ?, ?, ?, ?)',
        device.institution_id, device.id, binding.id, device.room, isoNow(), Date.now() + ACTIVATION_MS,
      );
      logEvent(device.id, 'activation.requested', `user ${binding.id}`);
      bus.publish(`user:${binding.id}`, 'activation', { id: activationId, room: device.room, device: device.name });
      notifier.notify(binding.id, { kind: 'device', title: `Confirm sign-in at ${device.room || device.name}`, body: 'You tapped your card. Open Campus OS to start the session.', link: `/classroom?activation=${activationId}`, urgent: true });
      return { result: 'activation_pending', name: binding.name.split(' ')[0] };
    }

    const session = db.get(
      `SELECT s.id, s.course_id FROM cx_attendance_sessions s JOIN enrollments e ON e.course_id = s.course_id AND e.user_id = ?
       WHERE s.institution_id = ? AND s.room = ? AND s.open = 1 ORDER BY s.id DESC LIMIT 1`,
      binding.id, device.institution_id, device.room,
    );
    if (!session) return { result: 'no_open_session', name: binding.name.split(' ')[0] };
    participation.checkin(session.id, binding.id, 'nfc_device');
    bus.publish(`course:${session.course_id}`, 'participation.updated', { sessionId: session.id });
    logEvent(device.id, 'checkin', `session ${session.id}`);
    return { result: 'checked_in', name: binding.name.split(' ')[0] };
  }

  async function handleVoice(device, data) {
    const question = clamp(data.text, 600);
    if (question.length < 2) throw badRequest('Empty question');
    if (!voiceLimiter.hit(device.id)) throw tooMany();
    const activation = activeActivation(device.id);
    if (!activation) return { result: 'inactive', text: 'Tap your staff card to start a session first.' };
    const user = db.get("SELECT u.*, i.name AS institution FROM users u JOIN institutions i ON i.id = u.institution_id WHERE u.id = ? AND u.institution_id = ? AND u.deleted = 0 AND u.role IN ('lecturer','admin')", activation.user_id, device.institution_id);
    if (!user) return { result: 'inactive', text: 'A current staff session is required.' };
    if (!ai.status(user).aiEnabled) return { result: 'unavailable', text: 'The assistant is not configured yet.' };
    const { references } = ai.retrieveContext(user, question);
    const answer = await ai.complete({ user, system: voicePrompt({ user, room: device.room, assistantName: site.assistant, sources: references }), prompt: question, maxTokens: 220 });
    deviceCommands.queue(device.id, 'speak', { text: answer });
    logEvent(device.id, 'voice.query', `${question.length} chars`);
    return { result: 'answer', text: answer };
  }

  function handleButton(device, data) {
    const button = clamp(data.button, 30);
    logEvent(device.id, 'button.press', button);
    const activation = activeActivation(device.id);
    if (button === 'end' && activation) {
      const user = db.get('SELECT * FROM users WHERE id = ?', activation.user_id);
      endActivation(user, activation);
      return { result: 'session_ended' };
    }
    return { result: 'ok' };
  }

  // ----------------------------------------------------------- Activations

  function activationFor(user, activationId) {
    const a = db.get('SELECT * FROM device_activations WHERE id = ? AND user_id = ?', id(activationId), user.id);
    if (!a) throw notFound('Activation not found');
    return a;
  }

  function endActivation(user, a) {
    db.run("UPDATE device_activations SET status = 'ended' WHERE id = ?", a.id);
    if (a.session_id) db.run('UPDATE cx_attendance_sessions SET open = 0 WHERE id = ?', a.session_id);
    if (a.room) rooms.setStatus(user, a.room, 'open', '');
    deviceCommands.queue(a.device_id, 'session.ended', {});
    bus.publish(`user:${user.id}`, 'activation', { id: a.id, status: 'ended' });
  }

  router.get('/api/activations', (ctx) => {
    const rows = db.all(
      `SELECT a.*, d.name AS device_name, d.kind AS device_kind, c.code AS course_code, c.title AS course_title
       FROM device_activations a JOIN devices d ON d.id = a.device_id LEFT JOIN courses c ON c.id = a.course_id
       WHERE a.user_id = ? AND ((a.status = 'pending' AND a.expires > ?) OR (a.status = 'confirmed' AND a.resolved > ?))
       ORDER BY a.id DESC`,
      ctx.user.id, Date.now(), new Date(Date.now() - 6 * 3_600_000).toISOString(),
    );
    const courses = db.all('SELECT id, code, title FROM courses WHERE institution_id = ? AND (lecturer_id = ? OR ? = \'admin\') ORDER BY code', ctx.user.institution_id, ctx.user.id, ctx.user.role);
    return { activations: rows.map((a) => ({ id: a.id, status: a.status, room: a.room, device: a.device_name, deviceKind: a.device_kind, created: a.created, expires: new Date(a.expires).toISOString(), course: a.course_id ? { id: a.course_id, code: a.course_code, title: a.course_title } : null, sessionId: a.session_id })), courses };
  }, { roles: ['lecturer', 'admin'] });

  router.post('/api/activations/:id', async (ctx) => {
    const a = activationFor(ctx.user, ctx.params.id);
    if (a.status !== 'pending' || a.expires < Date.now()) throw badRequest('This request has expired. Tap your card again.');
    const b = await ctx.json();
    const decision = oneOf(b.decision, ['confirm', 'deny'], 'Decision');
    if (decision === 'deny') {
      db.run("UPDATE device_activations SET status = 'denied', resolved = ? WHERE id = ?", isoNow(), a.id);
      deviceCommands.queue(a.device_id, 'display.message', { text: 'Sign-in declined' });
      audit(ctx.user, 'device_activation_denied', a.id);
      return { ok: true, status: 'denied' };
    }

    const courseId = optionalId(b.course_id, 'Course');
    const course = courseId ? access.teachingCourse(ctx.user, courseId) : null;
    if (courseId && !course) throw forbidden('Not your course');
    let sessionId = null;
    if (course && b.open_participation !== false) {
      sessionId = participation.create(ctx.user, course, { title: `${course.code} · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`, room: a.room, requireCode: true });
    }
    db.run("UPDATE device_activations SET status = 'confirmed', resolved = ?, course_id = ?, session_id = ? WHERE id = ?", isoNow(), course?.id || null, sessionId, a.id);
    const roomStatus = b.room_status && rooms.ROOM_STATUSES.includes(b.room_status) ? b.room_status : 'quiet';
    if (a.room) rooms.setStatus(ctx.user, a.room, roomStatus, course ? `${course.code} in session` : 'Session in progress');
    deviceCommands.queue(a.device_id, 'session.started', { lecturer: ctx.user.name.split(' ')[0], course: course ? `${course.code} · ${course.title}` : null, sessionId });
    audit(ctx.user, 'device_activation_confirmed', a.id);
    bus.publish(`user:${ctx.user.id}`, 'activation', { id: a.id, status: 'confirmed' });
    return { ok: true, status: 'confirmed', sessionId };
  }, { roles: ['lecturer', 'admin'] });

  router.post('/api/activations/:id/end', (ctx) => {
    const a = activationFor(ctx.user, ctx.params.id);
    if (a.status !== 'confirmed') throw badRequest('This session is not active');
    endActivation(ctx.user, a);
    return { ok: true };
  }, { roles: ['lecturer', 'admin'] });
}

module.exports = { register, KINDS };
