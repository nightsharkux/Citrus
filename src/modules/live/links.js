'use strict';
/**
 * A QR code for every lecture. Behind it is a link of its own (/join/<token>), made the first time the lecturer
 * asks for it, that stays the same for that lecture: it can go on a slide or a printed sheet before the lecture,
 * be shown on the projector during it, and still work when the lecture is opened again. Anyone can use it: people
 * who are signed in join at once, everyone else as a guest without an account (auth/routes.js, POST /api/guest).
 *
 *   GET  /api/live/lectures/:id/link   the lecture's link, made on first ask             (its lecturer)
 *   POST /api/live/lectures/:id/link   a new link: the old QR code stops working        (its lecturer)
 *   GET  /api/live/links/:token        what the link opens: lecture, course, whether it is live   (anyone)
 *   POST /api/live/join { token }      join with it (routes.js), like the six-digit code
 *
 * The token is random (72 bits), so links cannot be guessed the way six digits could be tried.
 */
const crypto = require('node:crypto');
const { id } = require('../../lib/validate');
const { forbidden, notFound, tooMany } = require('../../http/errors');
const { createRateLimiter } = require('../../http/rate-limit');

const TOKEN = /^[A-Za-z0-9_-]{12}$/;
const newToken = () => crypto.randomBytes(9).toString('base64url');
const isToken = (value) => TOKEN.test(String(value || ''));

function createLinks({ db }) {
  /** The lecture behind a link, with its course and university, or null. */
  function lectureOf(token) {
    if (!isToken(token)) return null;
    return db.get(
      `SELECT l.*, c.code AS course_code, c.title AS course_title, c.institution_id FROM lectures l JOIN courses c ON c.id = l.course_id
       WHERE l.join_token = ?`,
      String(token),
    ) || null;
  }

  /** The lecture's link token, made now when it has none yet. */
  function tokenFor(lectureId, { fresh = false } = {}) {
    const row = db.get('SELECT join_token FROM lectures WHERE id = ?', lectureId);
    if (!row) return '';
    if (row.join_token && !fresh) return row.join_token;
    for (let i = 0; i < 5; i += 1) {
      const token = newToken();
      if (db.get('SELECT 1 AS taken FROM lectures WHERE join_token = ?', token)) continue;
      // Only the first of two requests at once sets it, so both get the same link.
      db.run(`UPDATE lectures SET join_token = ? WHERE id = ?${fresh ? '' : " AND join_token = ''"}`, token, lectureId);
      return db.get('SELECT join_token FROM lectures WHERE id = ?', lectureId).join_token;
    }
    throw new Error('Could not make a link for the lecture');
  }

  const pathFor = (lectureId) => `/join/${tokenFor(lectureId)}`;
  const runningOf = (lectureId) => db.get('SELECT * FROM live_sessions WHERE lecture_id = ? AND ended IS NULL ORDER BY id DESC LIMIT 1', lectureId);

  return { lectureOf, tokenFor, pathFor, runningOf };
}

function registerLinks(router, { db, access }) {
  const links = createLinks({ db });
  const lookups = createRateLimiter({ windowMs: 60_000, max: 120 });

  /** A lecture its lecturer (or an admin) may make a QR code for. */
  const teachingLecture = (user, lectureId) => {
    const lecture = db.get('SELECT l.*, c.code AS course_code, c.title AS course_title FROM lectures l JOIN courses c ON c.id = l.course_id WHERE l.id = ? AND c.institution_id = ?', id(lectureId, 'Lecture'), user.institution_id);
    if (!lecture) throw notFound('Lecture not found');
    if (!access.teachingCourse(user, lecture.course_id)) throw forbidden('Only the lecturer can make the QR code');
    return lecture;
  };
  const linkView = (lecture, token) => ({
    path: `/join/${token}`,
    token,
    lecture: { id: lecture.id, title: lecture.topic, starts: lecture.starts || null, ends: lecture.ends || null, room: lecture.room || '' },
    course: { id: lecture.course_id, code: lecture.course_code, title: lecture.course_title },
    live: !!links.runningOf(lecture.id),
  });

  router.get('/api/live/lectures/:id/link', (ctx) => {
    const lecture = teachingLecture(ctx.user, ctx.params.id);
    return linkView(lecture, links.tokenFor(lecture.id));
  });

  router.post('/api/live/lectures/:id/link', (ctx) => {
    const lecture = teachingLecture(ctx.user, ctx.params.id);
    return linkView(lecture, links.tokenFor(lecture.id, { fresh: true }));
  });

  /** For the join page before anyone signs in: only what the QR code's own screen shows. */
  router.get('/api/live/links/:token', (ctx) => {
    if (!lookups.hit(`link:${ctx.ip}`)) throw tooMany('Too many tries. Wait a minute and scan the code again.');
    const lecture = links.lectureOf(ctx.params.token);
    if (!lecture) throw notFound('This QR code no longer works. Ask your lecturer for the current one.');
    return {
      lecture: { title: lecture.topic, starts: lecture.starts || null, ends: lecture.ends || null, room: lecture.room || '' },
      course: { code: lecture.course_code, title: lecture.course_title },
      live: !!links.runningOf(lecture.id),
    };
  }, { auth: 'public' });

  return links;
}

module.exports = { createLinks, registerLinks, isToken };
