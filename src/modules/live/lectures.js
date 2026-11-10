'use strict';
/**
 * The list of lectures people see: what is live now, what is coming up and what happened recently, across their
 * courses. Students also see lectures of other courses at their university, marked as joinable, so they can find
 * a lecture and join its course in one step.
 */
const DAY = 86_400_000;
const PAST_DAYS = 14;
const AHEAD_DAYS = 30;

/**
 * 'live'      a live session is running
 * 'upcoming'  scheduled and not over (including one that should have started but has not)
 * 'past'      ended, or its scheduled time has passed
 * 'open'      no schedule and not ended: a lecture a lecturer is collecting topics for
 */
function classify(lecture, { live = false, now = Date.now() } = {}) {
  if (live) return 'live';
  if (lecture.status === 'ended') return 'past';
  if (lecture.starts) {
    const end = Date.parse(lecture.ends || '') || Date.parse(lecture.starts) + 60 * 60_000;
    return end < now ? 'past' : 'upcoming';
  }
  return 'open';
}

/** Live first, then upcoming (soonest first), then the rest (newest first). */
function order(a, b) {
  const rank = { live: 0, upcoming: 1, open: 2, past: 3 };
  if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
  const at = Date.parse(a.starts || a.created);
  const bt = Date.parse(b.starts || b.created);
  return a.state === 'upcoming' ? at - bt : bt - at;
}

/** Whether a lecture belongs in the list at this moment. */
function inWindow(item, now) {
  if (item.state === 'live') return true;
  const at = Date.parse(item.starts || item.created);
  return at > now - PAST_DAYS * DAY && at < now + AHEAD_DAYS * DAY;
}

/**
 * @param scope 'mine' only the user's own courses (home screen); 'all' also other courses at the university (students)
 */
function buildFeed(db, user, { now = Date.now(), scope = 'all' } = {}) {
  const rows = db.all(
    `SELECT l.id, l.topic, l.status, l.starts, l.ends, l.room, l.created, l.course_id,
            c.code, c.title AS course, c.lecturer_id, lu.name AS lecturer,
            EXISTS(SELECT 1 FROM enrollments e WHERE e.course_id = c.id AND e.user_id = ?) AS enrolled,
            (SELECT s.id FROM live_sessions s WHERE s.lecture_id = l.id AND s.ended IS NULL ORDER BY s.id DESC LIMIT 1) AS live_id,
            (SELECT s.id FROM live_sessions s WHERE s.lecture_id = l.id ORDER BY s.id DESC LIMIT 1) AS last_session_id,
            (SELECT COUNT(*) FROM live_moments m JOIN live_sessions s ON s.id = m.session_id WHERE s.lecture_id = l.id AND m.kind = 'struggle') AS struggles
     FROM lectures l JOIN courses c ON c.id = l.course_id LEFT JOIN users lu ON lu.id = c.lecturer_id
     WHERE c.institution_id = ?`,
    user.id, user.institution_id,
  );
  const items = [];
  for (const r of rows) {
    const teaches = r.lecturer_id === user.id || user.role === 'admin';
    const mine = !!r.enrolled || teaches;
    if (user.role === 'lecturer' && !teaches) continue; // a lecturer's list is their own teaching
    if (scope === 'mine' && !mine) continue;
    const state = classify(r, { live: !!r.live_id, now });
    const item = {
      id: r.id, topic: r.topic, state, starts: r.starts, ends: r.ends, room: r.room, created: r.created,
      course: { id: r.course_id, code: r.code, title: r.course, lecturer: r.lecturer },
      enrolled: !!r.enrolled, teaches, liveSession: r.live_id || null,
      // The session to open for a review, and (for the lecturer only) how many times the class got lost.
      lastSession: r.last_session_id || null, ...(teaches ? { struggles: r.struggles } : {}),
    };
    if (inWindow(item, now)) items.push(item);
  }
  return items.sort(order);
}

module.exports = { classify, order, buildFeed, PAST_DAYS, AHEAD_DAYS };
