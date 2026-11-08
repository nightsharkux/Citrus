'use strict';
/**
 * Participation sessions and rotating check-in codes.
 *
 * A code changes every 30 seconds (HMAC of a per-session secret and the time
 * window, like TOTP). Typing the current code shows the student could see the
 * room's screen — useful evidence, but not proof of identity or presence.
 */
const crypto = require('node:crypto');

const WINDOW_MS = 30_000;

function codeFor(secret, window) {
  const mac = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(String(window)).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

function createParticipation({ db }) {
  function create(user, course, { title, room = '', requireCode = false }) {
    return db.insert(
      'INSERT INTO cx_attendance_sessions(institution_id, course_id, owner_id, title, room, created, code_secret, require_code) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      user.institution_id, course.id, user.id, title, room, new Date().toISOString(), crypto.randomBytes(16).toString('hex'), requireCode ? 1 : 0,
    );
  }

  function currentCode(session) {
    if (!session.code_secret) return null;
    const window = Math.floor(Date.now() / WINDOW_MS);
    return { code: codeFor(session.code_secret, window), expiresIn: WINDOW_MS - (Date.now() % WINDOW_MS), period: WINDOW_MS };
  }

  function verifyCode(session, code) {
    if (!session.code_secret) return false;
    const clean = String(code || '').replace(/\D/g, '');
    if (clean.length !== 6) return false;
    const window = Math.floor(Date.now() / WINDOW_MS);
    return [window, window - 1].some((w) => crypto.timingSafeEqual(Buffer.from(codeFor(session.code_secret, w)), Buffer.from(clean)));
  }

  function checkin(sessionId, userId, method) {
    const result = db.run('INSERT OR IGNORE INTO cx_checkins(session_id, user_id, method, created) VALUES(?, ?, ?, ?)', sessionId, userId, method, new Date().toISOString());
    return result.changes > 0;
  }

  return { create, currentCode, verifyCode, checkin };
}

module.exports = { createParticipation, codeFor };
