'use strict';
/**
 * A course over the term (live/term.js): for its lecturer, every lecture and topic with how well it landed and the
 * parts that went worst; for a student, their own results and every part they found hard, in one list.
 *
 *   GET /api/courses/:id/progress       lecturer: { view: 'term', … }; student: { view: 'mine', … }
 *   GET /api/courses/:id/progress.txt   the same as tagged text with instructions for any AI
 *
 * A student only ever gets their own record (record-source.js), never the lecturer's words or other students.
 */
const { id } = require('../../lib/validate');
const { forbidden } = require('../../http/errors');
const { createRecordSource } = require('../live/record-source');
const { buildTerm, buildProgress, termText, progressText } = require('../live/term');

const MAX_LECTURES = 60;

function createProgress({ db, access }) {
  const records = createRecordSource({ db, access });
  const topicsOf = (courseId) => db.all('SELECT id, parent_id, title FROM course_sections WHERE course_id = ? ORDER BY position, id', courseId);
  /** Finished lectures of the course, oldest first, with the topic each belongs to. */
  const sessionsOf = (course) => db.all(
    `SELECT s.*, l.section_id FROM live_sessions s LEFT JOIN lectures l ON l.id = s.lecture_id
     WHERE s.course_id = ? AND s.institution_id = ? AND s.ended IS NOT NULL ORDER BY s.started DESC, s.id DESC LIMIT ?`,
    course.id, course.institution_id, MAX_LECTURES,
  ).reverse();

  // All lectures of the term are loaded together (records.loadMany): a query per lecture would cost a round trip to
  // the hosted database each, and the term overview would get slower with every lecture.
  function term(course) {
    const sessions = sessionsOf(course);
    const loaded = records.loadMany(sessions, { audience: 'lecturer' });
    return buildTerm({
      course,
      topics: topicsOf(course.id),
      enrolled: db.get('SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?', course.id).n,
      lectures: sessions.map((s, i) => ({ session: s, sectionId: s.section_id, record: loaded[i] })),
    });
  }

  /** The lectures of the course this student was in (came in, or answered), in one query. */
  function tookPart(sessions, userId) {
    if (!sessions.length) return [];
    const ids = sessions.map((s) => s.id);
    const marks = ids.map(() => '?').join(',');
    const seen = new Set(db.all(
      `SELECT session_id FROM live_attendees WHERE user_id = ? AND session_id IN (${marks}) UNION SELECT session_id FROM live_signals WHERE user_id = ? AND session_id IN (${marks})`,
      userId, ...ids, userId, ...ids,
    ).map((r) => r.session_id));
    return sessions.filter((s) => seen.has(s.id));
  }

  function mine(course, user) {
    const took = tookPart(sessionsOf(course), user.id);
    const loaded = records.loadMany(took, { audience: 'student', studentId: user.id });
    return buildProgress({
      course,
      topics: topicsOf(course.id),
      lectures: took.map((s, i) => ({ session: s, sectionId: s.section_id, record: loaded[i] })),
    });
  }

  /** The view this person gets of the course, or null when it is not theirs. */
  function forUser(user, courseId) {
    const teaching = access.teachingCourse(user, courseId);
    if (teaching) return { view: 'term', ...term(teaching) };
    const course = access.course(user, courseId);
    return course ? { view: 'mine', ...mine(course, user) } : null;
  }

  const textOf = (view) => (view.view === 'term' ? termText(view) : progressText(view));

  return { term, mine, forUser, textOf };
}

function registerProgress(router, { db, access }) {
  const progress = createProgress({ db, access });
  const viewOf = (ctx) => {
    const view = progress.forUser(ctx.user, id(ctx.params.id, 'Course'));
    if (!view) throw forbidden('Join this course to see it');
    return view;
  };

  router.get('/api/courses/:id/progress', (ctx) => viewOf(ctx));

  router.get('/api/courses/:id/progress.txt', (ctx) => {
    const view = viewOf(ctx);
    const body = progress.textOf(view);
    const name = `${String(view.course.code || 'course').replace(/[^\w-]+/g, '-')}-${view.view === 'term' ? 'term-overview' : 'my-progress'}.txt`;
    ctx.res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'private, no-store',
    });
    ctx.res.end(body);
  });
}

module.exports = { createProgress, registerProgress };
