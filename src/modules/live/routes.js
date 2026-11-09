'use strict';
/**
 * Live lectures: the loop that makes Campus useful in a lecture room.
 *
 *   Students signal how they are following (following / unsure / lost) from their phones. The lecturer sees the
 *   class pulse update live, a minute-by-minute timeline, and can ask Campus things mid-lecture ("explain the last
 *   thing I said") with the lecture's notes, the recent speech and the pulse as context.
 *
 *   POST /api/live/sessions                  { course_id, title?, notes?: [attachmentId] }  start (lecturer)
 *   GET  /api/live/courses/:id/active        the running session of a course, or null       (course members)
 *   GET  /api/live/sessions/:id              state; the lecturer also gets pulse, timeline, notes
 *   POST /api/live/sessions/:id/signal       { level: 1|2|3 }                                (enrolled student)
 *   POST /api/live/sessions/:id/transcript   { text }  what the lecturer just said            (lecturer)
 *   POST /api/live/sessions/:id/notes        { attachment_ids }  add prepared notes           (lecturer)
 *   POST /api/live/sessions/:id/ask          { question }  → { answer }                       (lecturer)
 *   POST /api/live/sessions/:id/end          finish; returns the summary                      (lecturer)
 *
 * Privacy: students only ever see their own last signal. The lecturer sees anonymous counts. Speech is kept in
 * memory (transcript.js), never in the database.
 */
const { text, id, integer } = require('../../lib/validate');
const { badRequest, forbidden, notFound, conflict, unavailable } = require('../../http/errors');
const { liveAskPrompt } = require('../../ai/prompts');
const { assistantNameFor } = require('../account/preferences');
const { createAttachments } = require('../assistant/attachments');
const { createTranscripts } = require('./transcript');
const { pulse, timeline, roughPatches } = require('./pulse');
const { buildFeed } = require('./lectures');

const SIGNAL_GAP_MS = 15_000;
const LEVELS = { 1: 'following', 2: 'unsure', 3: 'lost' };

function register(router, { db, ai, access, bus, site, notifier }) {
  const attachments = createAttachments({ db });
  const transcripts = createTranscripts();
  const isoNow = () => new Date().toISOString();

  // ---- lookups ---------------------------------------------------------------------------------------------

  const sessionFor = (user, sessionId) => {
    const s = db.get('SELECT * FROM live_sessions WHERE id = ? AND institution_id = ?', id(sessionId, 'Lecture'), user.institution_id);
    if (!s) throw notFound('Lecture not found');
    return s;
  };
  /** A session its own lecturer (or an admin) may run. */
  const teaching = (user, sessionId) => {
    const s = sessionFor(user, sessionId);
    if (!access.teachingCourse(user, s.course_id)) throw forbidden('Only the lecturer can do this');
    return s;
  };
  /** A session a member of the course may join. */
  const joined = (user, sessionId) => {
    const s = sessionFor(user, sessionId);
    if (!access.course(user, s.course_id)) throw forbidden('Join this course first');
    return s;
  };
  const activeOf = (courseId) => db.get('SELECT * FROM live_sessions WHERE course_id = ? AND ended IS NULL ORDER BY id DESC LIMIT 1', courseId);

  // ---- views -----------------------------------------------------------------------------------------------

  const enrolledCount = (courseId) => db.get('SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?', courseId).n;
  const signalsOf = (sessionId) => db.all('SELECT user_id, level, created FROM live_signals WHERE session_id = ? ORDER BY id', sessionId);
  const notesOf = (sessionId) => db.all(
    `SELECT a.id, a.kind, a.name, a.mime, a.size, a.text, a.data FROM live_notes n JOIN assistant_attachments a ON a.id = n.attachment_id WHERE n.session_id = ?`,
    sessionId,
  );

  const publicSession = (s) => ({ id: s.id, course_id: s.course_id, title: s.title, started: s.started, ended: s.ended });

  function livePulse(s) {
    return pulse(signalsOf(s.id), { enrolled: enrolledCount(s.course_id) });
  }

  /** Tell the lecturer's open screens that the pulse moved. Anonymous aggregates only. */
  function announce(s) {
    bus.publish(`user:${s.lecturer_id}`, 'live.pulse', { session: s.id, pulse: livePulse(s) });
  }

  function lecturerView(s) {
    const signals = signalsOf(s.id);
    const line = timeline(signals, s.started, { now: s.ended ? Date.parse(s.ended) : Date.now() });
    return {
      session: publicSession(s),
      pulse: pulse(signals, { enrolled: enrolledCount(s.course_id) }),
      timeline: line,
      roughPatches: roughPatches(line),
      notes: notesOf(s.id).map(({ id: noteId, kind, name, mime, size }) => ({ id: noteId, kind, name, mime, size })),
      heard: transcripts.size(s.id),
    };
  }

  // ---- routes ----------------------------------------------------------------------------------------------

  router.post('/api/live/sessions', async (ctx) => {
    const user = ctx.user;
    const b = await ctx.json();
    const course = access.teachingCourse(user, id(b.course_id, 'Course'));
    if (!course) throw forbidden('Only the lecturer of a course can start its lecture');
    const running = activeOf(course.id);
    if (running) return { ...lecturerView(running), resumed: true };

    // A live session belongs to a lecture: the scheduled one the lecturer chose, or a new one made right now.
    let lecture = null;
    if (b.lecture_id !== undefined && b.lecture_id !== null && b.lecture_id !== '') {
      lecture = db.get('SELECT * FROM lectures WHERE id = ? AND course_id = ?', id(b.lecture_id, 'Lecture'), course.id);
      if (!lecture) throw notFound('Lecture not found');
    }
    const title = text(b.title, { max: 120, optional: true, label: 'Title' }) || lecture?.topic || `${course.code} lecture`;
    if (!lecture) {
      const lectureId = db.insert('INSERT INTO lectures(course_id, topic, starts, ends, created) VALUES(?, ?, ?, ?, ?)', course.id, title, isoNow(), new Date(Date.now() + 60 * 60_000).toISOString(), isoNow());
      lecture = db.get('SELECT * FROM lectures WHERE id = ?', lectureId);
    }
    db.run("UPDATE lectures SET status = 'active' WHERE id = ?", lecture.id);
    const sessionId = db.insert('INSERT INTO live_sessions(institution_id, course_id, lecturer_id, lecture_id, title, started) VALUES(?, ?, ?, ?, ?, ?)', user.institution_id, course.id, user.id, lecture.id, title, isoNow());
    attachNotes(user, sessionId, b.notes);
    bus.publish(`course:${course.id}`, 'live.started', { session: sessionId, title });
    const students = db.all('SELECT user_id FROM enrollments WHERE course_id = ?', course.id).map((r) => r.user_id);
    notifier.notify(students, { kind: 'course', title: `${title} is live`, body: `${course.code}. Tell your lecturer how you're following.`, link: `/live/${course.id}` });
    ctx.status = 201;
    return lecturerView(sessionFor(user, sessionId));
  });

  /** Notes are uploaded first (pictures and PDFs, via /api/assistant/attachments), then attached by id. */
  function attachNotes(user, sessionId, ids) {
    if (!Array.isArray(ids) || !ids.length) return;
    const wanted = [...new Set(ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 12);
    const own = db.all(`SELECT id FROM assistant_attachments WHERE user_id = ? AND id IN (${wanted.map(() => '?').join(',')})`, user.id, ...wanted);
    if (own.length !== wanted.length) throw badRequest('One of the notes is no longer available. Upload it again.');
    for (const row of own) db.run('INSERT OR IGNORE INTO live_notes(session_id, attachment_id) VALUES(?, ?)', sessionId, row.id);
  }

  /** For the home screen: lectures running now in the user's courses, and (for a lecturer) their courses to start one in. */
  router.get('/api/live/mine', (ctx) => {
    const user = ctx.user;
    if (user.role === 'student') {
      const running = db.all(
        `SELECT s.id, s.title, s.started, s.course_id, c.code, c.title AS course FROM live_sessions s
         JOIN courses c ON c.id = s.course_id JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
         WHERE s.ended IS NULL AND s.institution_id = ? ORDER BY s.started DESC`, user.id, user.institution_id,
      );
      return { running, courses: [] };
    }
    if (user.role !== 'lecturer') return { running: [], courses: [] };
    const courses = db.all('SELECT id, code, title FROM courses WHERE lecturer_id = ? AND institution_id = ? ORDER BY code', user.id, user.institution_id)
      .map((c) => ({ ...c, running: activeOf(c.id)?.id || null }));
    return { running: [], courses };
  });

  /**
   * The lectures a person can see: live now, coming up and recent. scope=mine limits it to their own courses.
   * Students also see other courses' lectures at their university and can join the course from the list.
   */
  router.get('/api/lectures/feed', (ctx) => ({
    lectures: buildFeed(db, ctx.user, { scope: ctx.query.get('scope') === 'mine' ? 'mine' : 'all' }),
  }));

  router.get('/api/live/courses/:id/active', (ctx) => {
    const course = access.course(ctx.user, id(ctx.params.id, 'Course'));
    if (!course) throw forbidden('Join this course first');
    const s = activeOf(course.id);
    if (!s) return { session: null };
    const mine = ctx.user.id === s.lecturer_id || ctx.user.role === 'admin' ? null : db.get('SELECT level, created FROM live_signals WHERE session_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', s.id, ctx.user.id);
    return { session: publicSession(s), course: { id: course.id, code: course.code, title: course.title }, mine: mine || null };
  });

  router.get('/api/live/sessions/:id', (ctx) => {
    const s = joined(ctx.user, ctx.params.id);
    if (access.teachingCourse(ctx.user, s.course_id)) return lecturerView(s);
    const mine = db.get('SELECT level, created FROM live_signals WHERE session_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', s.id, ctx.user.id);
    return { session: publicSession(s), mine: mine || null };
  });

  router.post('/api/live/sessions/:id/signal', async (ctx) => {
    const user = ctx.user;
    const s = joined(ctx.user, ctx.params.id);
    if (s.ended) throw conflict('This lecture has ended');
    if (user.role !== 'student' || !access.isEnrolled(user.id, s.course_id)) throw forbidden('Only students of this course can send signals');
    const b = await ctx.json();
    const level = integer(b.level, { min: 1, max: 3, label: 'Signal' });
    const last = db.get('SELECT created FROM live_signals WHERE session_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', s.id, user.id);
    if (last && Date.now() - Date.parse(last.created) < SIGNAL_GAP_MS) throw conflict('Wait a few seconds before changing your answer.');
    const created = isoNow();
    db.insert('INSERT INTO live_signals(session_id, user_id, level, created) VALUES(?, ?, ?, ?)', s.id, user.id, level, created);
    announce(s);
    return { level, label: LEVELS[level], created };
  });

  router.post('/api/live/sessions/:id/transcript', async (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    if (s.ended) throw conflict('This lecture has ended');
    const b = await ctx.json();
    return { lines: transcripts.add(s.id, text(b.text, { min: 1, max: 600, label: 'Text' })) };
  });

  router.post('/api/live/sessions/:id/notes', async (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    const b = await ctx.json();
    attachNotes(ctx.user, s.id, b.attachment_ids);
    return lecturerView(s);
  });

  router.post('/api/live/sessions/:id/ask', async (ctx) => {
    const user = ctx.user;
    const s = teaching(user, ctx.params.id);
    const b = await ctx.json();
    const question = text(b.question, { min: 2, max: 600, label: 'Question' });
    if (!ai.status(user).aiEnabled) throw unavailable('The assistant is not connected yet.');

    const course = db.get('SELECT code, title FROM courses WHERE id = ?', s.course_id);
    const view = lecturerView(s);
    const seen = attachments.forModel(notesOf(s.id));
    const heard = transcripts.recent(s.id);
    const system = liveAskPrompt({
      user, assistantName: assistantNameFor(user, site), course, title: s.title,
      minutesIn: Math.max(0, Math.round((Date.now() - Date.parse(s.started)) / 60000)),
      pulse: view.pulse, roughPatches: view.roughPatches,
    });
    const turn = {
      text: [`<TRANSCRIPT>\n${heard || '(nothing heard yet)'}\n</TRANSCRIPT>`, ...seen.blocks, `The lecturer asks: ${question}`].join('\n\n'),
      images: seen.images,
    };
    const answer = await ai.complete({ user, system, prompt: turn, maxTokens: 700, task: 'voice' });
    return { answer: answer.trim(), heard: heard.length > 0, notes: seen.names };
  });

  router.post('/api/live/sessions/:id/end', (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    if (!s.ended) db.run('UPDATE live_sessions SET ended = ? WHERE id = ?', isoNow(), s.id);
    transcripts.clear(s.id); // the lecture was never recorded; forget what was heard
    if (s.lecture_id) db.run("UPDATE lectures SET status = 'ended', ends = CASE WHEN ends IS NULL OR ends > ? THEN ? ELSE ends END WHERE id = ?", isoNow(), isoNow(), s.lecture_id);
    const summary = lecturerView(sessionFor(ctx.user, s.id));
    bus.publish(`course:${s.course_id}`, 'live.ended', { session: s.id });
    return summary;
  });
}

module.exports = { register };
