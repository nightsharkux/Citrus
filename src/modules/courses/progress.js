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

  function term(course) {
    return buildTerm({
      course,
      topics: topicsOf(course.id),
      enrolled: db.get('SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?', course.id).n,
      lectures: sessionsOf(course).map((s) => ({ session: s, sectionId: s.section_id, record: records.load(s, { audience: 'lecturer', light: true }) })),
    });
  }

  function mine(course, user) {
    const took = sessionsOf(course).filter((s) => db.get(
      'SELECT 1 AS yes FROM live_attendees WHERE session_id = ? AND user_id = ? UNION SELECT 1 FROM live_signals WHERE session_id = ? AND user_id = ? LIMIT 1',
      s.id, user.id, s.id, user.id,
    ));
    return buildProgress({
      course,
      topics: topicsOf(course.id),
      lectures: took.map((s) => ({ session: s, sectionId: s.section_id, record: records.load(s, { audience: 'student', studentId: user.id }) })),
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
