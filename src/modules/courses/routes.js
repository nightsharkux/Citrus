'use strict';
/**
 * Courses, lectures, topics, understanding ratings, concept checks and
 * classroom status notices.
 *
 * Understanding ratings are self-reports (1 = lost, 2 = getting there,
 * 3 = got it). Lecturers only ever see aggregate counts.
 */
const { text, id, integer, oneOf, clamp } = require('../../lib/validate');
const { badRequest, forbidden, notFound, conflict } = require('../../http/errors');
const { ROOM_STATUSES } = require('../../services/rooms');
const { registerSections } = require('./sections');
const { registerProgress } = require('./progress');

/**
 * The optional time and room of a lecture: starts (an ISO time), duration_minutes (default 60, up to 8 hours), room.
 * Times are stored in UTC; browsers show them in the viewer's time zone.
 */
function readSchedule(b) {
  const room = text(b.room, { max: 60, optional: true, label: 'Room' }) || '';
  if (b.starts === undefined || b.starts === null || b.starts === '') return { starts: null, ends: null, room };
  const at = Date.parse(b.starts);
  if (!Number.isFinite(at)) throw badRequest('Choose a valid start time');
  if (at < Date.now() - 366 * 86_400_000 || at > Date.now() + 2 * 366 * 86_400_000) throw badRequest('That date looks wrong. Please check it.');
  const minutes = b.duration_minutes === undefined || b.duration_minutes === null || b.duration_minutes === '' ? 60 : Number(b.duration_minutes);
  if (!Number.isInteger(minutes) || minutes < 10 || minutes > 480) throw badRequest('A lecture lasts between 10 minutes and 8 hours');
  return { starts: new Date(at).toISOString(), ends: new Date(at + minutes * 60_000).toISOString(), room };
}

function register(router, { db, access, bus, notifier, audit, rooms, blobs }) {
  const now = () => new Date().toISOString();
  const touchCourse = (courseId) => bus.publish(`course:${courseId}`, 'course.updated', { courseId });
  registerSections(router, { db, access, bus, blobs }); // topics, files and links: the course page as an outline
  registerProgress(router, { db, access }); // the term so far: the lecturer's overview, a student's own progress

  /** Full course view for one user; polls hide the correct answer from students until they answer. */
  function snapshot(user, course) {
    const isTeacher = !!access.teachingCourse(user, course.id);
    const lectures = db.all('SELECT * FROM lectures WHERE course_id = ? ORDER BY id DESC', course.id);
    const topics = db.all('SELECT t.* FROM topics t JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = ? ORDER BY t.id', course.id);
    const counts = db.all(
      `SELECT r.topic_id, r.level, COUNT(*) n FROM responses r JOIN topics t ON t.id = r.topic_id JOIN lectures l ON l.id = t.lecture_id
       WHERE l.course_id = ? GROUP BY r.topic_id, r.level`, course.id,
    );
    const mine = new Map(db.all(
      'SELECT r.topic_id, r.level FROM responses r JOIN topics t ON t.id = r.topic_id JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = ? AND r.user_id = ?',
      course.id, user.id,
    ).map((r) => [r.topic_id, r.level]));
    const polls = db.all('SELECT p.* FROM polls p JOIN topics t ON t.id = p.topic_id JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = ? ORDER BY p.id DESC', course.id);
    const myAnswers = new Map(db.all(
      'SELECT pa.poll_id, pa.answer FROM poll_answers pa JOIN polls p ON p.id = pa.poll_id JOIN topics t ON t.id = p.topic_id JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = ? AND pa.user_id = ?',
      course.id, user.id,
    ).map((a) => [a.poll_id, a.answer]));
    const answerStats = new Map(db.all(
      `SELECT pa.poll_id, COUNT(*) total, SUM(CASE WHEN pa.answer = p.correct THEN 1 ELSE 0 END) correct
       FROM poll_answers pa JOIN polls p ON p.id = pa.poll_id JOIN topics t ON t.id = p.topic_id JOIN lectures l ON l.id = t.lecture_id
       WHERE l.course_id = ? GROUP BY pa.poll_id`, course.id,
    ).map((s) => [s.poll_id, s]));
    const distribution = isTeacher ? db.all(
      `SELECT pa.poll_id, pa.answer, COUNT(*) n FROM poll_answers pa JOIN polls p ON p.id = pa.poll_id JOIN topics t ON t.id = p.topic_id JOIN lectures l ON l.id = t.lecture_id
       WHERE l.course_id = ? GROUP BY pa.poll_id, pa.answer`, course.id,
    ) : [];

    const shapePoll = (p) => {
      const myAnswer = myAnswers.has(p.id) ? myAnswers.get(p.id) : null;
      const stats = answerStats.get(p.id) || { total: 0, correct: 0 };
      const options = JSON.parse(p.options);
      return {
        id: p.id,
        topic_id: p.topic_id,
        question: p.question,
        options,
        myAnswer,
        total: stats.total,
        correctCount: stats.correct || 0,
        ...(isTeacher || myAnswer !== null ? { correct: p.correct } : {}),
        ...(isTeacher ? { distribution: options.map((_, i) => distribution.find((d) => d.poll_id === p.id && d.answer === i)?.n || 0) } : {}),
      };
    };

    const shapeTopic = (t) => {
      const c = { 1: 0, 2: 0, 3: 0 };
      for (const row of counts) if (row.topic_id === t.id) c[row.level] = row.n;
      return { ...t, counts: c, myLevel: mine.get(t.id) || null, polls: polls.filter((p) => p.topic_id === t.id).map(shapePoll) };
    };

    const lecturer = course.lecturer_id ? db.get('SELECT name FROM users WHERE id = ?', course.lecturer_id)?.name : null;
    const enrolled = db.get('SELECT COUNT(*) n FROM enrollments WHERE course_id = ?', course.id).n;
    return {
      course: { ...course, lecturer, enrolled },
      isTeacher,
      lectures: lectures.map((l) => {
        const live = db.get('SELECT id FROM live_sessions WHERE lecture_id = ? AND ended IS NULL ORDER BY id DESC LIMIT 1', l.id);
        const last = db.get('SELECT id FROM live_sessions WHERE lecture_id = ? ORDER BY id DESC LIMIT 1', l.id);
        return { ...l, live: !!live, liveSession: live?.id || null, lastSession: last?.id || null, topics: topics.filter((t) => t.lecture_id === l.id).map(shapeTopic) };
      }),
    };
  }

  router.get('/api/courses', (ctx) => {
    const u = ctx.user;
    let rows = db.all(
      `SELECT c.id, c.title, c.code, c.lecturer_id, u.name AS lecturer,
              (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) AS enrolled_count
       FROM courses c LEFT JOIN users u ON u.id = c.lecturer_id WHERE c.institution_id = ? ORDER BY c.code`,
      u.institution_id,
    );
    if (u.role === 'student') {
      const mine = new Set(db.all('SELECT course_id FROM enrollments WHERE user_id = ?', u.id).map((r) => r.course_id));
      rows = rows.map((c) => ({ ...c, enrolled: mine.has(c.id) }));
    }
    if (u.role === 'lecturer') rows = rows.filter((c) => c.lecturer_id === u.id);
    return { courses: rows };
  });

  router.post('/api/courses', async (ctx) => {
    const b = await ctx.json();
    const title = text(b.title, { min: 3, max: 160, label: 'Course title' });
    const code = text(b.code, { min: 2, max: 30, label: 'Course code' }).toUpperCase();
    if (db.get('SELECT id FROM courses WHERE institution_id = ? AND code = ?', ctx.user.institution_id, code)) throw conflict('A course with this code already exists');
    // A lecturer who makes a course teaches it; an administrator can assign a lecturer afterwards.
    const lecturerId = ctx.user.role === 'lecturer' ? ctx.user.id : null;
    const courseId = db.insert('INSERT INTO courses(institution_id, title, code, lecturer_id) VALUES(?, ?, ?, ?)', ctx.user.institution_id, title, code, lecturerId);
    audit(ctx.user, 'course_created', courseId);
    ctx.status = 201;
    return { id: courseId };
  }, { roles: ['lecturer', 'admin'] });

  router.patch('/api/courses/:id', async (ctx) => {
    const course = access.teachingCourse(ctx.user, id(ctx.params.id));
    if (!course) throw notFound('Course not found');
    const b = await ctx.json();
    const title = b.title !== undefined ? text(b.title, { min: 3, max: 160, label: 'Course title' }) : course.title;
    const code = b.code !== undefined ? text(b.code, { min: 2, max: 30, label: 'Course code' }).toUpperCase() : course.code;
    if (code !== course.code && db.get('SELECT id FROM courses WHERE institution_id = ? AND code = ? AND id != ?', ctx.user.institution_id, code, course.id)) throw conflict('A course with this code already exists');
    db.run('UPDATE courses SET title = ?, code = ? WHERE id = ?', title, code, course.id);
    audit(ctx.user, 'course_updated', course.id);
    return { ok: true };
  }, { roles: ['lecturer', 'admin'] });

  router.get('/api/courses/:id', (ctx) => {
    const course = access.course(ctx.user, id(ctx.params.id));
    if (!course) throw forbidden('Join this course to see it');
    return snapshot(ctx.user, course);
  });

  router.post('/api/courses/:id/enroll', (ctx) => {
    if (ctx.user.role !== 'student') throw forbidden('Only students enrol in courses');
    const courseId = id(ctx.params.id);
    if (!db.get('SELECT id FROM courses WHERE id = ? AND institution_id = ?', courseId, ctx.user.institution_id)) throw notFound('Course not found');
    db.run('INSERT OR IGNORE INTO enrollments(course_id, user_id) VALUES(?, ?)', courseId, ctx.user.id);
    return { ok: true };
  });

  router.post('/api/courses/:id/leave', (ctx) => {
    db.run('DELETE FROM enrollments WHERE course_id = ? AND user_id = ?', id(ctx.params.id), ctx.user.id);
    return { ok: true };
  });

  router.post('/api/courses/:id/lectures', async (ctx) => {
    const course = access.teachingCourse(ctx.user, id(ctx.params.id));
    if (!course) throw forbidden('Not your course');
    const b = await ctx.json();
    const topic = text(b.topic, { min: 3, max: 160, label: 'Lecture title' });
    const when = readSchedule(b);
    // A lecture can belong to a topic of the course outline (or to the whole course).
    const sectionId = b.section_id === undefined || b.section_id === null || b.section_id === '' ? null : db.get('SELECT id FROM course_sections WHERE id = ? AND course_id = ?', id(b.section_id, 'Topic'), course.id)?.id;
    if (sectionId === undefined) throw badRequest('That topic is not in this course');
    const lectureId = db.insert('INSERT INTO lectures(course_id, topic, starts, ends, room, created, section_id) VALUES(?, ?, ?, ?, ?, ?, ?)', course.id, topic, when.starts, when.ends, when.room, now(), sectionId);
    audit(ctx.user, 'lecture_created', lectureId);
    touchCourse(course.id);
    if (when.starts) {
      // Students find it in Lectures; this only tells the ones already in the course.
      const students = db.all('SELECT user_id FROM enrollments WHERE course_id = ?', course.id).map((r) => r.user_id);
      notifier.notify(students, { kind: 'course', title: `Lecture scheduled: ${topic}`, body: `${course.code}${when.room ? ` · ${when.room}` : ''}`, link: '/lectures' });
    }
    ctx.status = 201;
    return { id: lectureId };
  });

  router.patch('/api/lectures/:id', async (ctx) => {
    const lecture = access.lecture(ctx.user, id(ctx.params.id), { teach: true });
    if (!lecture) throw forbidden('Not your lecture');
    const b = await ctx.json();
    if (b.status === undefined && b.starts === undefined && b.room === undefined) throw badRequest('Nothing to change');
    if (b.status !== undefined) {
      const status = oneOf(b.status, ['active', 'ended'], 'Status');
      db.run('UPDATE lectures SET status = ? WHERE id = ?', status, lecture.id);
      // Ending a lecture ends its live session too, so students are not left in a lecture that is over.
      if (status === 'ended') {
        for (const s of db.all('SELECT id FROM live_sessions WHERE lecture_id = ? AND ended IS NULL', lecture.id)) {
          db.run('UPDATE live_sessions SET ended = ? WHERE id = ?', now(), s.id);
          bus.publish(`course:${lecture.course_id}`, 'live.ended', { session: s.id });
        }
      }
    }
    if (b.starts !== undefined || b.room !== undefined || b.duration_minutes !== undefined) {
      const when = readSchedule({ starts: b.starts ?? lecture.starts, duration_minutes: b.duration_minutes ?? (lecture.starts && lecture.ends ? Math.round((Date.parse(lecture.ends) - Date.parse(lecture.starts)) / 60000) : undefined), room: b.room ?? lecture.room });
      db.run('UPDATE lectures SET starts = ?, ends = ?, room = ? WHERE id = ?', when.starts, when.ends, when.room, lecture.id);
    }
    touchCourse(lecture.course_id);
    return { ok: true };
  });

  router.post('/api/lectures/:id/topics', async (ctx) => {
    const lecture = access.lecture(ctx.user, id(ctx.params.id), { teach: true });
    if (!lecture) throw forbidden('No access');
    const b = await ctx.json();
    const title = text(b.title, { min: 3, max: 160, label: 'Topic' });
    const topicId = db.insert('INSERT INTO topics(lecture_id, title, created) VALUES(?, ?, ?)', lecture.id, title, now());
    touchCourse(lecture.course_id);
    ctx.status = 201;
    return { id: topicId };
  });

  router.post('/api/topics/:id/respond', async (ctx) => {
    if (ctx.user.role !== 'student') throw forbidden('Only students rate their understanding');
    const topic = access.topic(ctx.user, id(ctx.params.id));
    if (!topic) throw forbidden('Join the course first');
    const b = await ctx.json();
    const level = Number(b.level);
    if (![1, 2, 3].includes(level)) throw badRequest('Choose how well you understood this topic');
    db.run(
      `INSERT INTO responses(topic_id, user_id, level, created) VALUES(?, ?, ?, ?)
       ON CONFLICT(topic_id, user_id) DO UPDATE SET level = excluded.level, created = excluded.created`,
      topic.id, ctx.user.id, level, now(),
    );
    touchCourse(topic.course_id);
    return { ok: true };
  });

  router.post('/api/topics/:id/polls', async (ctx) => {
    const topic = access.topic(ctx.user, id(ctx.params.id), { teach: true });
    if (!topic) throw forbidden('Not your topic');
    const b = await ctx.json();
    const question = text(b.question, { min: 10, max: 300, label: 'Question' });
    const options = Array.isArray(b.options) ? b.options.map((o) => clamp(o, 140)).filter(Boolean) : [];
    if (options.length < 2 || options.length > 5) throw badRequest('Give between 2 and 5 answer options');
    const correct = integer(b.correct, { min: 0, max: options.length - 1, label: 'Correct answer' });
    const pollId = db.insert('INSERT INTO polls(topic_id, question, options, correct, created) VALUES(?, ?, ?, ?, ?)', topic.id, question, JSON.stringify(options), correct, now());
    touchCourse(topic.course_id);

    const course = db.get('SELECT code FROM courses WHERE id = ?', topic.course_id);
    const students = db.all('SELECT user_id FROM enrollments WHERE course_id = ?', topic.course_id).map((r) => r.user_id);
    notifier.notify(students, { kind: 'course', title: `New concept check in ${course.code}`, body: question, link: `/courses/${topic.course_id}` });
    ctx.status = 201;
    return { id: pollId };
  });

  router.post('/api/polls/:id/answer', async (ctx) => {
    if (ctx.user.role !== 'student') throw forbidden('Only students answer concept checks');
    const poll = db.get('SELECT * FROM polls WHERE id = ?', id(ctx.params.id));
    const topic = poll && access.topic(ctx.user, poll.topic_id);
    if (!topic) throw forbidden('Join the course first');
    const b = await ctx.json();
    const options = JSON.parse(poll.options);
    const answer = integer(b.answer, { min: 0, max: options.length - 1, label: 'Answer' });
    db.run('INSERT OR IGNORE INTO poll_answers(poll_id, user_id, answer, created) VALUES(?, ?, ?, ?)', poll.id, ctx.user.id, answer, now());
    touchCourse(topic.course_id);
    return { recorded: true, correct: answer === poll.correct, correctAnswer: poll.correct };
  });

  /** Student learning summary across enrolled courses. */
  router.get('/api/study', (ctx) => {
    if (ctx.user.role !== 'student') throw forbidden('Students only');
    const u = ctx.user;
    const topics = db.all(
      `SELECT t.id, t.title, c.id AS course_id, c.title AS course, c.code, r.level
       FROM topics t JOIN lectures l ON l.id = t.lecture_id JOIN courses c ON c.id = l.course_id
       JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
       LEFT JOIN responses r ON r.topic_id = t.id AND r.user_id = ?
       WHERE c.institution_id = ? ORDER BY t.id DESC`,
      u.id, u.id, u.institution_id,
    );
    const pollStats = db.all(
      `SELECT p.id, p.question, c.code, c.id AS course_id, pa.answer, p.correct FROM poll_answers pa JOIN polls p ON p.id = pa.poll_id
       JOIN topics t ON t.id = p.topic_id JOIN lectures l ON l.id = t.lecture_id JOIN courses c ON c.id = l.course_id
       WHERE pa.user_id = ? AND c.institution_id = ?`,
      u.id, u.institution_id,
    ).map((p) => ({ id: p.id, question: p.question, course: p.code, course_id: p.course_id, correct: p.answer === p.correct }));
    return { topics, pollStats };
  });

  // --- Classroom status ---

  router.get('/api/notices', (ctx) => ({
    notices: db.all('SELECT room, status, note, updated FROM notices WHERE institution_id = ? ORDER BY room', ctx.user.institution_id),
  }));

  router.post('/api/notices', async (ctx) => {
    const b = await ctx.json();
    const room = text(b.room, { min: 1, max: 80, label: 'Room' });
    const status = oneOf(b.status, ROOM_STATUSES, 'Status');
    const note = clamp(b.note, 240);
    rooms.setStatus(ctx.user, room, status, note);
    return { ok: true };
  }, { roles: ['lecturer', 'admin'] });

  router.delete('/api/notices/:room', (ctx) => {
    rooms.clear(ctx.user, ctx.params.room);
    return { ok: true };
  }, { roles: ['lecturer', 'admin'] });

  router.post('/api/suggestions', async (ctx) => {
    const b = await ctx.json();
    const message = text(b.message, { min: 5, max: 2000, label: 'Suggestion' });
    db.run('INSERT INTO suggestions(institution_id, user_id, message, created) VALUES(?, ?, ?, ?)', ctx.user.institution_id, ctx.user.id, message, now());
    ctx.status = 201;
    return { ok: true };
  });
}

module.exports = { register };
