'use strict';
/**
 * Participation sessions. Check-in methods are recorded honestly:
 *   self_reported, code_verified, lecturer_confirmed, nfc_assisted_unverified, nfc_device
 * None of them is proof of identity or physical presence.
 */
const { text, id, clamp } = require('../../lib/validate');
const { badRequest, forbidden, notFound } = require('../../http/errors');
const { hmac } = require('../../lib/crypto');

function register(router, { db, access, bus, participation, nfcKey }) {
  const isoNow = () => new Date().toISOString();

  const teaching = (user, courseId) => access.teachingCourse(user, courseId);
  const sessionFor = (user, sessionId) => db.get(
    'SELECT s.*, c.title AS course_title, c.code AS course_code FROM cx_attendance_sessions s JOIN courses c ON c.id = s.course_id WHERE s.id = ? AND s.institution_id = ?',
    id(sessionId), user.institution_id,
  );
  const touch = (s) => bus.publish(`course:${s.course_id}`, 'participation.updated', { sessionId: s.id });

  function uidDigest(input) {
    const uid = clamp(input, 100).replace(/[^a-fA-F0-9]/g, '').toUpperCase();
    if (uid.length < 6 || uid.length > 32 || uid.length % 2) return null;
    return hmac(nfcKey, uid);
  }

  router.get('/api/participation', (ctx) => {
    const u = ctx.user;
    const filter = u.role === 'student'
      ? 'AND EXISTS(SELECT 1 FROM enrollments e WHERE e.course_id = s.course_id AND e.user_id = ?)'
      : u.role === 'lecturer' ? 'AND s.owner_id = ?' : '';
    const args = u.role === 'admin' ? [u.institution_id] : [u.institution_id, u.id];
    const sessions = db.all(
      `SELECT s.id, s.title, s.room, s.open, s.created, s.require_code, s.course_id, c.code, c.title AS course,
              (SELECT COUNT(*) FROM cx_checkins ch WHERE ch.session_id = s.id) AS checkins,
              EXISTS(SELECT 1 FROM cx_checkins ch WHERE ch.session_id = s.id AND ch.user_id = ?) AS mine
       FROM cx_attendance_sessions s JOIN courses c ON c.id = s.course_id
       WHERE s.institution_id = ? ${filter} ORDER BY s.id DESC LIMIT 75`,
      u.id, ...args,
    );
    const courses = u.role === 'student' ? [] : db.all("SELECT id, title, code FROM courses WHERE institution_id = ? AND (? = 'admin' OR lecturer_id = ?) ORDER BY code", u.institution_id, u.role, u.id);
    return { sessions: sessions.map((s) => ({ ...s, open: !!s.open, mine: !!s.mine, require_code: !!s.require_code })), courses };
  });

  router.post('/api/participation', async (ctx) => {
    const b = await ctx.json();
    const course = teaching(ctx.user, id(b.course_id, 'Course'));
    if (!course) throw forbidden('Not your course');
    const title = text(b.title, { min: 3, max: 120, label: 'Session title' });
    const room = text(b.room, { max: 60, optional: true });
    const sessionId = participation.create(ctx.user, course, { title, room, requireCode: b.require_code === true });
    ctx.status = 201;
    return { id: sessionId };
  }, { roles: ['lecturer', 'admin'] });

  router.get('/api/participation/:id', (ctx) => {
    const s = sessionFor(ctx.user, ctx.params.id);
    if (!s) throw notFound('Session not found');
    const teacherAccess = !!teaching(ctx.user, s.course_id);
    if (!teacherAccess && !access.isEnrolled(ctx.user.id, s.course_id)) throw forbidden('Course enrolment required');
    const people = teacherAccess ? db.all(
      `SELECT u.id, u.name, u.email, (ch.user_id IS NOT NULL) AS checked, ch.method, ch.created,
              EXISTS(SELECT 1 FROM cx_nfc_bindings b WHERE b.user_id = u.id) AS has_card
       FROM enrollments e JOIN users u ON u.id = e.user_id LEFT JOIN cx_checkins ch ON ch.session_id = ? AND ch.user_id = u.id
       WHERE e.course_id = ? AND u.deleted = 0 ORDER BY u.name`,
      s.id, s.course_id,
    ).map((p) => ({ ...p, checked: !!p.checked, has_card: !!p.has_card })) : [];
    const { code_secret: _secret, ...session } = s;
    return {
      session: { ...session, open: !!s.open, require_code: !!s.require_code },
      teacherAccess,
      people,
      mine: !!db.get('SELECT 1 FROM cx_checkins WHERE session_id = ? AND user_id = ?', s.id, ctx.user.id),
      total: db.get('SELECT COUNT(*) n FROM cx_checkins WHERE session_id = ?', s.id).n,
    };
  });

  /** Current rotating code, for the lecturer's screen. */
  router.get('/api/participation/:id/code', (ctx) => {
    const s = sessionFor(ctx.user, ctx.params.id);
    if (!s || !teaching(ctx.user, s.course_id)) throw forbidden('Not your session');
    if (!s.open) throw badRequest('Session is closed');
    if (!s.code_secret) throw badRequest('This session was created without check-in codes');
    return participation.currentCode(s);
  });

  router.post('/api/participation/:id/checkin', async (ctx) => {
    const s = sessionFor(ctx.user, ctx.params.id);
    if (!s || !s.open) throw notFound('No open session');
    const b = await ctx.json();
    const canTeach = !!teaching(ctx.user, s.course_id);
    const target = b.user_id ? id(b.user_id) : ctx.user.id;
    if (target !== ctx.user.id && !canTeach) throw forbidden('You cannot check in another student');
    if (!access.isEnrolled(target, s.course_id)) throw forbidden('Student is not enrolled in this course');

    let method = target === ctx.user.id ? 'self_reported' : 'lecturer_confirmed';
    if (target === ctx.user.id && b.code !== undefined) {
      if (!participation.verifyCode(s, b.code)) throw badRequest('That code is not current. Check the screen and try again.');
      method = 'code_verified';
    } else if (target === ctx.user.id && s.require_code) {
      throw badRequest('Enter the code shown in the room');
    }
    participation.checkin(s.id, target, method);
    touch(s);
    return { ok: true, method, notice: 'Check-in recorded. This is a participation record, not proof of identity or presence.' };
  });

  router.post('/api/participation/:id/close', (ctx) => {
    const s = sessionFor(ctx.user, ctx.params.id);
    if (!s || !teaching(ctx.user, s.course_id)) throw forbidden('Not your session');
    db.run('UPDATE cx_attendance_sessions SET open = 0 WHERE id = ?', s.id);
    touch(s);
    return { ok: true };
  });

  router.post('/api/participation/:id/reopen', (ctx) => {
    const s = sessionFor(ctx.user, ctx.params.id);
    if (!s || !teaching(ctx.user, s.course_id)) throw forbidden('Not your session');
    db.run('UPDATE cx_attendance_sessions SET open = 1 WHERE id = ?', s.id);
    touch(s);
    return { ok: true };
  });

  // Manual card pairing (no reader needed). Kept for testing and for desks with USB readers.
  router.post('/api/participation/:id/nfc/bind', async (ctx) => {
    const s = sessionFor(ctx.user, ctx.params.id);
    if (!s || !teaching(ctx.user, s.course_id) || !s.open) throw forbidden('Instructor access to an open session required');
    const b = await ctx.json();
    const target = Number(b.user_id);
    const digest = uidDigest(b.card_uid);
    if (!digest || !Number.isSafeInteger(target)) throw badRequest('A valid card UID and enrolled student are required');
    if (b.confirm_student_consent !== true) throw badRequest('Confirm the student agreed to link their card');
    if (!access.isEnrolled(target, s.course_id)) throw forbidden('Student is not enrolled');
    const existing = db.get('SELECT user_id FROM cx_nfc_bindings WHERE institution_id = ? AND uid_digest = ?', ctx.user.institution_id, digest);
    if (existing && existing.user_id !== target) throw badRequest('This card is already linked to a different student');
    db.run('DELETE FROM cx_nfc_bindings WHERE institution_id = ? AND user_id = ?', ctx.user.institution_id, target);
    db.run('INSERT INTO cx_nfc_bindings(institution_id, uid_digest, user_id, bound_by, created) VALUES(?, ?, ?, ?, ?)', ctx.user.institution_id, digest, target, ctx.user.id, isoNow());
    return { ok: true, notice: 'Card linked. Only a keyed digest of the UID is stored.' };
  });

  router.post('/api/participation/:id/nfc/checkin', async (ctx) => {
    const s = sessionFor(ctx.user, ctx.params.id);
    if (!s || !teaching(ctx.user, s.course_id) || !s.open) throw forbidden('Instructor access to an open session required');
    const b = await ctx.json();
    const digest = uidDigest(b.card_uid);
    if (!digest) throw badRequest('Invalid card UID');
    const bind = db.get('SELECT user_id FROM cx_nfc_bindings WHERE institution_id = ? AND uid_digest = ?', ctx.user.institution_id, digest);
    if (!bind) throw notFound('This card is not linked to anyone');
    if (!access.isEnrolled(bind.user_id, s.course_id)) throw forbidden('The linked student is not enrolled');
    participation.checkin(s.id, bind.user_id, 'nfc_assisted_unverified');
    touch(s);
    const person = db.get('SELECT name FROM users WHERE id = ?', bind.user_id);
    return { ok: true, name: person?.name || 'Student', notice: 'Card check-in recorded. Not proof of identity or presence.' };
  });
}

module.exports = { register };
