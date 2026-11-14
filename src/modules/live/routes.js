'use strict';
/**
 * Live lectures: the loop that makes Campus useful in a lecture room.
 *
 *   The lecturer starts the lecture and shows a six-digit code. Students type it on their phones (that also joins
 *   the course), then tell the lecturer how they are following (following / unsure / lost) and flag moments they
 *   need help with ("didn't get this", "too fast", "need an example", a question, with an optional note). The
 *   lecturer sees the class pulse, a minute-by-minute timeline and the flags live, without names, and can ask
 *   Campus things mid-lecture with the notes, what it heard and the flags as context. Students can ask Campus
 *   about the lecture privately, during it and afterwards, and get each of their flags explained.
 *
 *   POST /api/live/sessions                     { course_id, lecture_id?, title?, notes?, keep_transcript? }  (lecturer)
 *   POST /api/live/join                         { code }  join the running lecture with its code             (student)
 *   GET  /api/live/courses/:id/active           the running session of a course, or null                   (members)
 *   GET  /api/live/sessions/:id                 state; the lecturer also gets pulse, timeline, flags, notes
 *   POST /api/live/sessions/:id/signal          { level: 1|2|3 }                                (enrolled student)
 *   POST /api/live/sessions/:id/flags           { kind, note? }  mark this moment               (enrolled student)
 *   POST /api/live/sessions/:id/flags/:fid/explain   an explanation of one of my flags          (that student)
 *   POST /api/live/sessions/:id/student-ask     { question } → { answer }  privately            (enrolled student)
 *   POST /api/live/sessions/:id/transcript      { text }  what the lecturer just said           (lecturer)
 *   POST /api/live/sessions/:id/audio           audio from the Android app's background recording → transcript
 *                                               lines; the audio is kept only with file storage and when the
 *                                               lecturer keeps the transcript                    (lecturer)
 *   GET  /api/live/sessions/:id/recording.aac   that audio as one file, streamed                 (lecturer)
 *   GET  /api/live/sessions/:id/transcript.txt  the lecture record with the kept transcript       (lecturer)
 *   GET  /api/live/sessions/:id/record.txt      the tagged lecture record, with instructions for any AI
 *                                               (lecturer: everything; student: their own results)
 *   POST /api/live/sessions/:id/ai-notes        Campus writes the notes from the record → { markdown, txt }
 *                                               (lecturer: notes and teaching review; student: study notes)
 *   POST /api/live/sessions/:id/review-chat     { message, history } → { answer }  improve it with Campus (lecturer)
 *   DELETE /api/live/sessions/:id/transcript    forget the kept transcript                      (lecturer)
 *   POST /api/live/sessions/:id/notes           { attachment_ids }  add prepared notes          (lecturer)
 *   POST /api/live/sessions/:id/ask             { question }  → { answer }                      (lecturer)
 *   POST /api/live/sessions/:id/end             finish; returns the summary                     (lecturer)
 *
 * Privacy: students only ever see their own signals and flags. The lecturer sees anonymous counts and flag notes
 * without names. Speech is stored only when the lecturer chose to keep the transcript; students never get it
 * word for word, only answers from it.
 */
const crypto = require('node:crypto');
const { text, id, integer, oneOf } = require('../../lib/validate');
const { badRequest, forbidden, notFound, conflict, unavailable, tooMany } = require('../../http/errors');
const { liveAskPrompt, liveStudentAskPrompt, liveFlagExplainPrompt, lectureNotesPrompt, lectureReviewPrompt, lectureQuickTakePrompt, FLAG_LABELS } = require('../../ai/prompts');
const { recordText, recordSummary, transcriptText } = require('./record');
const { createRecordSource } = require('./record-source');
const { topicFilesText } = require('../courses/sections');
const { readAudio, transcribe, spread } = require('../speech/transcribe');
const { pipeTo } = require('../../services/blob');
const { createRateLimiter } = require('../../http/rate-limit');
const { assistantNameFor } = require('../account/preferences');
const { createAttachments } = require('../assistant/attachments');
const { createTranscripts } = require('./transcript');
const { pulse, timeline, roughPatches, personalTimeline } = require('./pulse');
const { createMoments } = require('./moments');
const { buildFeed } = require('./lectures');

const SIGNAL_GAP_MS = 15_000;
const FLAG_GAP_MS = 8_000;
const MAX_FLAGS = 40;
const LEVELS = { 1: 'following', 2: 'unsure', 3: 'lost' };
const FLAG_KINDS = Object.keys(FLAG_LABELS);
const LISTENING_MS = 90_000;
const TRANSCRIPT_FOR_AI = 40_000;

/** "[minute 12] …" lines, one mark per minute, from stored transcript rows. */
function byMinute(rows, maxChars = TRANSCRIPT_FOR_AI) {
  let out = '';
  let mark = 0;
  for (const r of rows) {
    if (r.minute !== mark) {
      mark = r.minute;
      out += `\n[minute ${r.minute}] `;
    }
    out += `${r.text} `;
  }
  return out.trim().slice(-maxChars);
}

function register(router, { db, ai, access, bus, site, notifier, deviceCommands, blobs = { enabled: false } }) {
  const attachments = createAttachments({ db });
  const transcripts = createTranscripts();
  const moments = createMoments({ db, ai, bus, transcripts });
  const joinAttempts = createRateLimiter({ windowMs: 60_000, max: 12 });
  const notesWriting = createRateLimiter({ windowMs: 60_000, max: 4 });
  const isoNow = () => new Date().toISOString();
  const minuteOf = (s, at = Date.now()) => Math.max(1, Math.ceil((at - Date.parse(s.started)) / 60_000));
  const language = (user) => (user?.preferences?.language === 'de' ? 'de' : 'en');

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
  /** A session an enrolled student takes part in. */
  const attending = (user, sessionId) => {
    const s = joined(user, sessionId);
    if (user.role !== 'student' || !access.isEnrolled(user.id, s.course_id)) throw forbidden('Only students of this course can do this');
    return s;
  };
  const activeOf = (courseId) => db.get('SELECT * FROM live_sessions WHERE course_id = ? AND ended IS NULL ORDER BY id DESC LIMIT 1', courseId);

  /**
   * Six digits no other running lecture at the university uses. Reopening a lecture keeps the code it had, so
   * students who saw it on the screen can come back with it.
   */
  function joinCodeFor(institutionId, lectureId) {
    const before = lectureId ? db.get("SELECT join_code FROM live_sessions WHERE lecture_id = ? AND join_code != '' ORDER BY id DESC LIMIT 1", lectureId) : null;
    if (before && !db.get('SELECT 1 FROM live_sessions WHERE institution_id = ? AND join_code = ? AND ended IS NULL', institutionId, before.join_code)) return before.join_code;
    return newJoinCode(institutionId);
  }
  function newJoinCode(institutionId) {
    for (let i = 0; i < 20; i += 1) {
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      if (!db.get('SELECT 1 FROM live_sessions WHERE institution_id = ? AND join_code = ? AND ended IS NULL', institutionId, code)) return code;
    }
    throw conflict('Could not make a join code. Try again.');
  }

  // ---- views -----------------------------------------------------------------------------------------------

  const enrolledCount = (courseId) => db.get('SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?', courseId).n;
  const presentCount = (sessionId) => db.get('SELECT COUNT(*) AS n FROM live_attendees WHERE session_id = ?', sessionId).n;
  const signalsOf = (sessionId) => db.all('SELECT user_id, level, created FROM live_signals WHERE session_id = ? ORDER BY id', sessionId);
  const notesOf = (sessionId) => db.all(
    `SELECT a.id, a.kind, a.name, a.mime, a.size, a.text, a.data FROM live_notes n JOIN assistant_attachments a ON a.id = n.attachment_id WHERE n.session_id = ?`,
    sessionId,
  );
  /**
   * What Campus reads as the lecture's notes: the files the lecturer added to the lecture, plus the readable files
   * of the course topic the lecture belongs to (and the topics around it).
   */
  const notesFor = (s) => {
    const seen = attachments.forModel(notesOf(s.id));
    const topic = topicFilesText(db, s.lecture_id);
    return topic ? { ...seen, blocks: [...seen.blocks, topic] } : seen;
  };
  /** Flags without names: what the lecturer and the AI see. */
  const flagsOf = (sessionId) => db.all('SELECT id, kind, minute, note, created FROM live_flags WHERE session_id = ? ORDER BY id', sessionId);
  const flagCounts = (flags) => Object.fromEntries(FLAG_KINDS.map((k) => [k, flags.filter((f) => f.kind === k).length]));
  const storedLines = (sessionId) => db.get('SELECT COUNT(*) AS n FROM live_transcript WHERE session_id = ?', sessionId).n;

  const publicSession = (s) => ({ id: s.id, course_id: s.course_id, lecture_id: s.lecture_id, title: s.title, started: s.started, ended: s.ended, keepTranscript: !!s.keep_transcript });
  const listening = (s) => !s.ended && Date.now() - transcripts.lastAt(s.id) < LISTENING_MS;

  /** What Campus heard: the stored transcript when kept (by minute), otherwise the last minutes in memory. */
  function heardText(s, { from = 0, to = Infinity, maxChars = TRANSCRIPT_FOR_AI } = {}) {
    if (s.keep_transcript) {
      const rows = db.all('SELECT minute, text FROM live_transcript WHERE session_id = ? AND minute >= ? AND minute <= ? ORDER BY id', s.id, from, Number.isFinite(to) ? to : 100_000);
      if (rows.length) return byMinute(rows, maxChars);
    }
    return transcripts.recent(s.id, { minutes: 10, maxChars });
  }

  function livePulse(s) {
    return pulse(signalsOf(s.id), { enrolled: enrolledCount(s.course_id) });
  }

  /**
   * The class status on the Campus Puck (and any door light or display) in the lecture's room: green, amber or red,
   * so the lecturer sees at a glance when to explain again. Sent only when the status changes. Counts only.
   */
  const lastPuck = new Map();
  function puck(s, p) {
    if (!deviceCommands) return 0;
    const room = s.lecture_id ? db.get('SELECT room FROM lectures WHERE id = ?', s.lecture_id)?.room : '';
    const status = s.ended ? 'off' : p.status;
    if (!room || lastPuck.get(s.id) === status) return 0;
    lastPuck.set(s.id, status);
    return deviceCommands.toRoom(s.institution_id, room, 'class.pulse', { session: s.id, status, following: p.following, unsure: p.unsure, lost: p.lost, answered: p.answered });
  }

  /** Tell the lecturer's open screens that the pulse moved. Anonymous aggregates only. */
  function announce(s) {
    const p = livePulse(s);
    bus.publish(`user:${s.lecturer_id}`, 'live.pulse', { session: s.id, pulse: p });
    puck(s, p);
    moments.onPulse(s, p); // when the class tips into trouble, keep that moment for the lecturer's review
  }

  function lecturerView(s) {
    const signals = signalsOf(s.id);
    const line = timeline(signals, s.started, { now: s.ended ? Date.parse(s.ended) : Date.now() });
    const flags = flagsOf(s.id);
    return {
      session: { ...publicSession(s), joinCode: s.ended ? null : s.join_code },
      pulse: pulse(signals, { enrolled: enrolledCount(s.course_id) }),
      timeline: line,
      roughPatches: roughPatches(line),
      notes: notesOf(s.id).map(({ id: noteId, kind, name, mime, size }) => ({ id: noteId, kind, name, mime, size })),
      flags: flags.slice(-60).map(({ id: flagId, kind, minute, note }) => ({ id: flagId, kind, minute, note })),
      flagCounts: flagCounts(flags),
      present: presentCount(s.id),
      heard: transcripts.size(s.id),
      stored: s.keep_transcript ? storedLines(s.id) : 0,
      listening: listening(s),
    };
  }

  function studentView(s, user) {
    const mine = db.get('SELECT level, created FROM live_signals WHERE session_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', s.id, user.id);
    const flags = db.all('SELECT id, kind, minute, note, explanation, created FROM live_flags WHERE session_id = ? AND user_id = ? ORDER BY id', s.id, user.id);
    return { session: publicSession(s), mine: mine || null, flags, listening: listening(s), minute: minuteOf(s), present: presentCount(s.id), notes: notesOf(s.id).length, shareName: sharesName(s.id, user.id) };
  }

  /**
   * The student is in the room: counted for the lecturer, once. Whether they show their name starts as they chose
   * in their last lecture.
   */
  function arrive(s, user) {
    if (s.ended || user.role !== 'student') return;
    const last = db.get('SELECT share_name FROM live_attendees WHERE user_id = ? ORDER BY joined DESC LIMIT 1', user.id);
    const r = db.run('INSERT OR IGNORE INTO live_attendees(session_id, user_id, joined, share_name) VALUES(?, ?, ?, ?)', s.id, user.id, isoNow(), last?.share_name ? 1 : 0);
    if (r?.changes) bus.publish(`user:${s.lecturer_id}`, 'live.presence', { session: s.id, present: presentCount(s.id) });
  }
  const sharesName = (sessionId, userId) => !!db.get('SELECT share_name FROM live_attendees WHERE session_id = ? AND user_id = ?', sessionId, userId)?.share_name;

  /** Students who chose to show their name in this lecture: id → { name, email }. */
  function namedStudents(sessionId) {
    const rows = db.all('SELECT u.id, u.name, u.email FROM live_attendees a JOIN users u ON u.id = a.user_id WHERE a.session_id = ? AND a.share_name = 1 ORDER BY u.name', sessionId);
    return new Map(rows.map((r) => [r.id, { name: r.name, email: r.email }]));
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
      // "Go live" inside a topic of the course outline: the new lecture belongs to that topic.
      const section = b.section_id ? db.get('SELECT id FROM course_sections WHERE id = ? AND course_id = ?', id(b.section_id, 'Topic'), course.id) : null;
      const lectureId = db.insert('INSERT INTO lectures(course_id, topic, starts, ends, created, section_id) VALUES(?, ?, ?, ?, ?, ?)', course.id, title, isoNow(), new Date(Date.now() + 60 * 60_000).toISOString(), isoNow(), section?.id || null);
      lecture = db.get('SELECT * FROM lectures WHERE id = ?', lectureId);
    }
    // Reopening an ended lecture: a new session with the same code, the same notes and the same transcript choice.
    const previous = db.get('SELECT * FROM live_sessions WHERE lecture_id = ? ORDER BY id DESC LIMIT 1', lecture.id);
    const room = text(b.room, { max: 60, optional: true, label: 'Room' });
    db.run("UPDATE lectures SET status = 'active', ends = CASE WHEN ends IS NULL OR ends < ? THEN ? ELSE ends END WHERE id = ?", isoNow(), new Date(Date.now() + 60 * 60_000).toISOString(), lecture.id);
    if (room) db.run('UPDATE lectures SET room = ? WHERE id = ?', room, lecture.id);
    // Keeping the transcript is the default: it is what lets Campus answer about the lecture afterwards.
    const keep = b.keep_transcript === false ? 0 : b.keep_transcript === true || !previous ? 1 : previous.keep_transcript;
    const sessionId = db.insert(
      'INSERT INTO live_sessions(institution_id, course_id, lecturer_id, lecture_id, title, started, join_code, keep_transcript) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      user.institution_id, course.id, user.id, lecture.id, title, isoNow(), joinCodeFor(user.institution_id, lecture.id), keep,
    );
    if (previous) db.run('INSERT OR IGNORE INTO live_notes(session_id, attachment_id) SELECT ?, attachment_id FROM live_notes WHERE session_id = ?', sessionId, previous.id);
    attachNotes(user, sessionId, b.notes);
    bus.publish(`course:${course.id}`, 'live.started', { session: sessionId, title, lecture: lecture.id, again: !!previous });
    const students = db.all('SELECT user_id FROM enrollments WHERE course_id = ?', course.id).map((r) => r.user_id);
    notifier.notify(students, { kind: 'course', title: previous ? `${title} is live again` : `${title} is live`, body: `${course.code}. Open it to tell your lecturer how you're following.`, link: `/live/${course.id}` });
    puck(sessionFor(user, sessionId), { status: 'quiet', following: 0, unsure: 0, lost: 0, answered: 0 });
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

  /**
   * A student types the code from the projector. Joins the course too (courses are open to every student at the
   * university), so nobody has to find the course first.
   */
  router.post('/api/live/join', async (ctx) => {
    const user = ctx.user;
    if (!joinAttempts.hit(user.id)) throw tooMany('Too many tries. Wait a minute and check the code on the screen.');
    const b = await ctx.json();
    const code = String(b.code ?? '').replace(/\D/g, '');
    if (code.length !== 6) throw badRequest('The code has six digits');
    const s = db.get('SELECT * FROM live_sessions WHERE institution_id = ? AND join_code = ? AND ended IS NULL ORDER BY id DESC LIMIT 1', user.institution_id, code);
    if (!s) throw notFound('No lecture is running with that code. Check the screen.');
    if (user.role === 'student') db.run('INSERT OR IGNORE INTO enrollments(course_id, user_id) VALUES(?, ?)', s.course_id, user.id);
    else if (!access.course(user, s.course_id)) throw forbidden('This code is for students of the course');
    arrive(s, user);
    return { session: s.id, course_id: s.course_id, title: s.title };
  });

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
    if (user.role !== 'lecturer' && user.role !== 'admin') return { running: [], courses: [] };
    const courses = db.all(
      `SELECT id, code, title FROM courses WHERE institution_id = ? AND (lecturer_id = ? OR ? = 'admin') ORDER BY code LIMIT 60`,
      user.institution_id, user.id, user.role,
    ).map((c) => ({ ...c, running: activeOf(c.id)?.id || null }));
    return { running: [], courses };
  });

  /**
   * After the lecture, for its lecturer: where it went wrong. The class timeline, the stretches of trouble, what was
   * being said at each one with a note on the likely sticking point, the flags, and the key points.
   */
  router.get('/api/live/sessions/:id/report', (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    const course = db.get('SELECT id, code, title FROM courses WHERE id = ?', s.course_id);
    const flags = flagsOf(s.id).map((f) => ({ ...f, excerpt: s.keep_transcript ? heardText(s, { from: f.minute - 1, to: f.minute, maxChars: 500 }) : '' }));
    return { ...lecturerView(s), flags, course, ...moments.list(s.id), answeredBy: new Set(signalsOf(s.id).map((x) => x.user_id)).size, record: recordSummary(recordOf(ctx.user, s, 'lecturer'), { detail: true }), recording: keptAudio(s) };
  });

  /** How much of the lecture's audio was kept (Android background recording with file storage), or null. */
  function keptAudio(s) {
    if (!blobs.enabled) return null;
    const pieces = recordingOf(s.id);
    return pieces.length ? { pieces: pieces.length, seconds: Math.round(pieces.reduce((n, x) => n + x.duration_ms, 0) / 1000) } : null;
  }

  /**
   * After the lecture, for a student: their own path through it (private), where the class got stuck, the key
   * points, and their own flags with explanations. Never what the lecturer said word for word.
   */
  router.get('/api/live/sessions/:id/recap', (ctx) => {
    const s = joined(ctx.user, ctx.params.id);
    const course = db.get('SELECT id, code, title FROM courses WHERE id = ?', s.course_id);
    const all = signalsOf(s.id);
    const end = s.ended ? Date.parse(s.ended) : Date.now();
    const line = timeline(all, s.started, { now: end });
    const mine = all.filter((x) => x.user_id === ctx.user.id);
    const { struggles, points } = moments.list(s.id, { excerpts: false });
    const flags = db.all('SELECT id, kind, minute, note, explanation FROM live_flags WHERE session_id = ? AND user_id = ? ORDER BY id', s.id, ctx.user.id);
    return {
      session: publicSession(s), course,
      mine: personalTimeline(mine, s.started, { now: end }),
      classPatches: roughPatches(line),
      struggles: struggles.map(({ minute, lost, answered, note }) => ({ minute, lost, answered, note })),
      points,
      flags,
      signals: mine.length,
      // Campus can answer about this lecture when it kept what it heard.
      canAsk: !!s.keep_transcript && storedLines(s.id) > 0,
      // Their own results, section by section, next to the class average: what to work on.
      record: recordSummary(recordOf(ctx.user, s, 'student'), { detail: true }),
      shareName: sharesName(s.id, ctx.user.id),
    };
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
    if (!s) return { session: null, course: { id: course.id, code: course.code, title: course.title } };
    const lecturer = access.teachingCourse(ctx.user, s.course_id);
    if (!lecturer) arrive(s, ctx.user);
    return { session: publicSession(s), course: { id: course.id, code: course.code, title: course.title }, ...(lecturer ? {} : studentView(s, ctx.user)) };
  });

  router.get('/api/live/sessions/:id', (ctx) => {
    const s = joined(ctx.user, ctx.params.id);
    if (access.teachingCourse(ctx.user, s.course_id)) return lecturerView(s);
    return studentView(s, ctx.user);
  });

  router.post('/api/live/sessions/:id/signal', async (ctx) => {
    const user = ctx.user;
    const s = attending(user, ctx.params.id);
    if (s.ended) throw conflict('This lecture has ended');
    const b = await ctx.json();
    const level = integer(b.level, { min: 1, max: 3, label: 'Signal' });
    const last = db.get('SELECT created FROM live_signals WHERE session_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', s.id, user.id);
    if (last && Date.now() - Date.parse(last.created) < SIGNAL_GAP_MS) throw conflict('Wait a few seconds before changing your answer.');
    const created = isoNow();
    db.insert('INSERT INTO live_signals(session_id, user_id, level, created) VALUES(?, ?, ?, ?)', s.id, user.id, level, created);
    arrive(s, user);
    announce(s);
    return { level, label: LEVELS[level], created };
  });

  /** A student marks this moment of the lecture. The lecturer sees it straight away, without the student's name. */
  router.post('/api/live/sessions/:id/flags', async (ctx) => {
    const user = ctx.user;
    const s = attending(user, ctx.params.id);
    if (s.ended) throw conflict('This lecture has ended');
    const b = await ctx.json();
    const kind = oneOf(b.kind, FLAG_KINDS, 'Flag');
    const note = text(b.note, { max: 240, optional: true, label: 'Note' }) || '';
    const mine = db.all('SELECT created FROM live_flags WHERE session_id = ? AND user_id = ? ORDER BY id DESC', s.id, user.id);
    if (mine.length >= MAX_FLAGS) throw conflict('You have flagged a lot already. Ask Campus instead, or talk to your lecturer after class.');
    if (mine[0] && Date.now() - Date.parse(mine[0].created) < FLAG_GAP_MS) throw conflict('Wait a few seconds before flagging again.');
    const minute = minuteOf(s);
    const created = isoNow();
    const flagId = db.insert('INSERT INTO live_flags(session_id, user_id, kind, minute, note, created) VALUES(?, ?, ?, ?, ?, ?)', s.id, user.id, kind, minute, note, created);
    arrive(s, user);
    bus.publish(`user:${s.lecturer_id}`, 'live.flag', { session: s.id, flag: { id: flagId, kind, minute, note } });
    ctx.status = 201;
    return { id: flagId, kind, minute, note, created, explanation: '' };
  });

  /** Campus explains one of the student's flags from what was said around it. Kept, so the recap shows it again. */
  router.post('/api/live/sessions/:id/flags/:flagId/explain', async (ctx) => {
    const user = ctx.user;
    const s = joined(user, ctx.params.id);
    const flag = db.get('SELECT * FROM live_flags WHERE id = ? AND session_id = ? AND user_id = ?', id(ctx.params.flagId, 'Flag'), s.id, user.id);
    if (!flag) throw notFound('Flag not found');
    if (flag.explanation) return { id: flag.id, explanation: flag.explanation };
    if (!ai.status(user).aiEnabled) throw unavailable('The assistant is not connected yet.');
    const seen = notesFor(s);
    const heard = heardText(s, { from: flag.minute - 4, to: flag.minute + 1, maxChars: 6000 });
    const turn = { text: [`<TRANSCRIPT>\n${heard || '(nothing was heard around this minute)'}\n</TRANSCRIPT>`, ...seen.blocks].join('\n\n'), images: seen.images };
    const explanation = String(await ai.complete({ user, system: liveFlagExplainPrompt({ kind: flag.kind, note: flag.note, minute: flag.minute, language: language(user) }), prompt: turn, maxTokens: 600, task: 'search' })).trim();
    db.run('UPDATE live_flags SET explanation = ? WHERE id = ?', explanation.slice(0, 4000), flag.id);
    return { id: flag.id, explanation, heard: !!heard };
  });

  /** A student asks about the lecture, privately: from what Campus heard, the notes and their own flags. */
  router.post('/api/live/sessions/:id/student-ask', async (ctx) => {
    const user = ctx.user;
    const s = attending(user, ctx.params.id);
    const b = await ctx.json();
    const question = text(b.question, { min: 2, max: 600, label: 'Question' });
    if (!ai.status(user).aiEnabled) throw unavailable('The assistant is not connected yet.');
    const course = db.get('SELECT code, title FROM courses WHERE id = ?', s.course_id);
    const seen = notesFor(s);
    const heard = heardText(s);
    const flags = db.all('SELECT kind, minute, note FROM live_flags WHERE session_id = ? AND user_id = ? ORDER BY id', s.id, user.id)
      .map((f) => `minute ${f.minute}: ${FLAG_LABELS[f.kind]}${f.note ? ` · "${f.note}"` : ''}`);
    const system = liveStudentAskPrompt({ user, assistantName: assistantNameFor(user, site), course, title: s.title, minutesIn: minuteOf(s), ended: !!s.ended, language: language(user) });
    const own = recordText(recordOf(user, s, 'student'));
    const results = own.slice(own.lastIndexOf('\n=== DATA ===\n') + 1);
    const turn = {
      text: [`<TRANSCRIPT>\n${heard || '(nothing heard yet)'}\n</TRANSCRIPT>`, ...seen.blocks, `<MY_FLAGS>\n${flags.join('\n') || '(none)'}\n</MY_FLAGS>`, `<MY_RESULTS>\n${results.trim().slice(0, 20_000)}\n</MY_RESULTS>`, `The student asks: ${question}`].join('\n\n'),
      images: seen.images,
    };
    const answer = await ai.complete({ user, system, prompt: turn, maxTokens: 700, task: 'search' });
    return { answer: String(answer).trim(), heard: heard.length > 0 };
  });

  router.post('/api/live/sessions/:id/transcript', async (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    if (s.ended) throw conflict('This lecture has ended');
    const b = await ctx.json();
    const line = text(b.text, { min: 1, max: 600, label: 'Text' });
    const lines = transcripts.add(s.id, line);
    if (s.keep_transcript) db.run('INSERT INTO live_transcript(session_id, minute, text, created) VALUES(?, ?, ?, ?)', s.id, minuteOf(s), line.replace(/\s+/g, ' ').trim(), isoNow());
    moments.onSpeech(s); // every few minutes: the key points of what was just said
    return { lines };
  });

  // ---- the lecture record (record.js): every result tagged with its second and section --------------------

  const audienceOf = (user, s) => (access.teachingCourse(user, s.course_id) ? 'lecturer' : 'student');

  /** Everything that happened in the lecture, as the record for the lecturer or for one student. */
  const records = createRecordSource({ db, access });
  const recordOf = (user, s, audience, { studentId = user.id } = {}) => records.load(s, { audience, studentId });
  const fileBase = (s) => {
    const course = db.get('SELECT code FROM courses WHERE id = ?', s.course_id);
    return `${course.code}-${s.title}-${s.started.slice(0, 10)}`.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').slice(0, 80);
  };
  function sendText(ctx, name, body) {
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    ctx.res.end(body);
  }

  /** The plain transcript (with its own short instructions), for its lecturer. Gone once the transcript is deleted. */
  router.get('/api/live/sessions/:id/transcript.txt', (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    if (!storedLines(s.id)) throw notFound(s.keep_transcript ? 'Nothing was heard in this lecture.' : 'The transcript of this lecture was not kept.');
    sendText(ctx, `${fileBase(s)}-transcript.txt`, transcriptText(recordOf(ctx.user, s, 'lecturer')));
  });

  /** A student shows (or hides) their name to the lecturer, with their answers and flags in this lecture. */
  router.post('/api/live/sessions/:id/share', async (ctx) => {
    const user = ctx.user;
    const s = attending(user, ctx.params.id);
    const b = await ctx.json();
    const share = b.share === true ? 1 : 0;
    db.run('INSERT OR IGNORE INTO live_attendees(session_id, user_id, joined, share_name) VALUES(?, ?, ?, ?)', s.id, user.id, isoNow(), share);
    db.run('UPDATE live_attendees SET share_name = ? WHERE session_id = ? AND user_id = ?', share, s.id, user.id);
    return { share: !!share };
  });

  /**
   * Campus's quick take for the lecturer: the few points worth discussing or acting on, each tied to its time and
   * part, before the full notes or a conversation.
   */
  router.post('/api/live/sessions/:id/quick-take', async (ctx) => {
    const user = ctx.user;
    const s = teaching(user, ctx.params.id);
    if (!ai.status(user).aiEnabled) throw unavailable('The assistant is not connected yet.');
    if (!notesWriting.hit(user.id)) throw tooMany('Campus is still thinking. Wait a minute and try again.');
    const record = recordOf(user, s, 'lecturer');
    const system = lectureQuickTakePrompt({ language: language(user), title: s.title });
    const answer = await ai.complete({ user, system, prompt: `<RECORD>\n${recordText({ ...record, notes: [] }).slice(0, 110_000)}\n</RECORD>`, maxTokens: 700, task: 'chat' });
    return { markdown: String(answer).trim() };
  });

  /**
   * The lecturer helps one student who chose to show their name: a message from the lecturer, for example to talk
   * after class or to say notes are coming. Arrives as a notification that opens the student's recap.
   */
  router.post('/api/live/sessions/:id/students/:userId/message', async (ctx) => {
    const user = ctx.user;
    const s = teaching(user, ctx.params.id);
    const studentId = id(ctx.params.userId, 'Student');
    if (!sharesName(s.id, studentId)) throw forbidden('This student has not shown their name in this lecture');
    const b = await ctx.json();
    const message = text(b.text, { min: 2, max: 600, label: 'Message' });
    notifier.notify([studentId], { kind: 'course', title: `${user.name.split(' ')[0]}: ${s.title}`, body: message, link: `/lectures/review/${s.id}` });
    return { ok: true };
  });

  /** The tagged record as .txt, with the instructions any AI follows. A student gets only their own results. */
  router.get('/api/live/sessions/:id/record.txt', (ctx) => {
    const s = joined(ctx.user, ctx.params.id);
    const audience = audienceOf(ctx.user, s);
    sendText(ctx, `${fileBase(s)}-${audience === 'student' ? 'my-record' : 'lecture-record'}.txt`, recordText(recordOf(ctx.user, s, audience)));
  });

  /**
   * Campus writes the notes from the record, following the same instructions any AI gets. Nothing is stored: the
   * phone downloads the PDF and the .txt. For a student, Campus may read what was said to explain it, but their
   * files never contain it word for word.
   */
  router.post('/api/live/sessions/:id/ai-notes', async (ctx) => {
    const user = ctx.user;
    const s = joined(user, ctx.params.id);
    const b = await ctx.json();
    // A lecturer may ask for the study notes of one student who showed their name, to give to them.
    const forStudent = b.student_id !== undefined && b.student_id !== null ? id(b.student_id, 'Student') : null;
    const lecturer = audienceOf(user, s) === 'lecturer';
    if (forStudent && (!lecturer || !sharesName(s.id, forStudent))) throw forbidden('This student has not shown their name in this lecture');
    const audience = lecturer && !forStudent ? 'lecturer' : 'student';
    if (!ai.status(user).aiEnabled) throw unavailable('Notes are written by the AI, which is not connected yet. The .txt record works without it.');
    if (!notesWriting.hit(user.id)) throw tooMany('Campus is still writing. Wait a minute and try again.');
    const record = recordOf(user, s, audience, { studentId: forStudent || user.id });
    const seen = notesFor(s);
    const heard = audience === 'student' && s.keep_transcript ? heardText(s, { maxChars: 30_000 }) : '';
    const prompt = {
      text: [`<RECORD>\n${recordText({ ...record, notes: [] }).slice(0, 110_000)}\n</RECORD>`, heard ? `<TRANSCRIPT>\n${heard}\n</TRANSCRIPT>` : '', ...seen.blocks].filter(Boolean).join('\n\n'),
      images: seen.images,
    };
    const system = lectureNotesPrompt({ audience, language: language(user), assistantName: assistantNameFor(user, site), title: s.title, course: record.meta.course });
    const markdown = String(await ai.complete({ user, system, prompt, maxTokens: 5000, task: 'chat' })).trim();
    if (!markdown) throw unavailable('Campus could not write the notes this time. Try again.');
    const who = forStudent ? namedStudents(s.id).get(forStudent)?.name || 'student' : '';
    const name = `${fileBase(s)}-${forStudent ? `notes-for-${who.replace(/[^\w-]+/g, '-')}` : audience === 'student' ? 'my-notes' : 'lecture-notes'}`;
    return {
      audience, name, markdown,
      record: recordSummary(record),
      txt: recordText(record, { extra: `=== NOTES WRITTEN BY CAMPUS (Markdown) ===\n${markdown}` }),
    };
  });

  /**
   * The lecturer and Campus talk about the lecture in its review: why an explanation did not land, how to say it
   * better, improved notes for next time. Campus has the whole record. The conversation stays on the lecturer's
   * device (history comes with each message); nothing is stored.
   */
  router.post('/api/live/sessions/:id/review-chat', async (ctx) => {
    const user = ctx.user;
    const s = teaching(user, ctx.params.id);
    const b = await ctx.json();
    const message = text(b.message, { min: 2, max: 2000, label: 'Message' });
    if (!ai.status(user).aiEnabled) throw unavailable('The assistant is not connected yet.');
    const history = (Array.isArray(b.history) ? b.history : [])
      .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
      .slice(-12)
      .map((h) => ({ role: h.role, content: h.content.slice(0, 8000) }));
    const record = recordOf(user, s, 'lecturer');
    const seen = notesFor(s);
    const system = `${lectureReviewPrompt({ user, assistantName: assistantNameFor(user, site), title: s.title, course: record.meta.course, language: language(user) })}\n\n<RECORD>\n${recordText({ ...record, notes: [] }).slice(0, 110_000)}\n</RECORD>`;
    const answer = await ai.complete({ user, system, prompt: { text: [message, ...seen.blocks].join('\n\n'), images: seen.images }, history, maxTokens: 3000, task: 'chat' });
    return { answer: String(answer).trim() };
  });

  /**
   * A minute or so of lecture audio from the Android app, recorded in the background (screen off, app closed).
   * Transcribed into transcript lines at the times they were said; the audio itself is not kept.
   */
  router.post('/api/live/sessions/:id/audio', async (ctx) => {
    const user = ctx.user;
    const s = teaching(user, ctx.params.id);
    if (s.ended) throw conflict('This lecture has ended');
    const piece = await readAudio(ctx);
    // The audio itself is kept like the transcript: only when the lecturer keeps it, and only with file storage.
    if (blobs.enabled && s.keep_transcript) {
      try {
        const kept = await blobs.put(`live/${s.id}/${piece.startedAt}-${crypto.randomUUID().slice(0, 8)}.${piece.mime === 'audio/mpeg' ? 'mp3' : piece.mime === 'audio/aac' ? 'aac' : 'm4a'}`, piece.buffer, { contentType: piece.mime });
        db.run('INSERT INTO live_recordings(session_id, user_id, blob_url, mime, bytes, recorded_at, duration_ms, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
          s.id, user.id, kept.url, piece.mime, piece.buffer.length, piece.startedAt, piece.durationMs, new Date().toISOString());
      } catch (error) {
        console.warn(`Lecture audio not kept: ${error.message}`); // the transcript still works without it
      }
    }
    const lines = spread(await transcribe({ ai, user, buffer: piece.buffer, mime: piece.mime, language: language(user) }), piece.startedAt, piece.durationMs);
    for (const line of lines) {
      transcripts.add(s.id, line.text);
      if (s.keep_transcript) db.run('INSERT INTO live_transcript(session_id, minute, text, created) VALUES(?, ?, ?, ?)', s.id, minuteOf(s, Date.parse(line.created)), line.text, line.created);
    }
    if (lines.length) moments.onSpeech(s);
    return { lines: lines.length, text: lines.map((l) => l.text) };
  });

  /** Pieces of a recording that play as one file when joined end to end (ADTS AAC and MP3 do). */
  const recordingOf = (sessionId) => db.all("SELECT * FROM live_recordings WHERE session_id = ? AND mime IN ('audio/aac', 'audio/mpeg') ORDER BY recorded_at, id", sessionId);

  router.get('/api/live/sessions/:id/recording.aac', async (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    const pieces = recordingOf(s.id);
    if (!pieces.length || !blobs.enabled) throw notFound('No recording was kept for this lecture.');
    const mime = pieces[0].mime;
    const all = pieces.filter((p) => p.mime === mime);
    ctx.res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': all.reduce((n, p) => n + p.bytes, 0),
      'Content-Disposition': `attachment; filename="${fileBase(s)}-recording.${mime === 'audio/mpeg' ? 'mp3' : 'aac'}"`,
      'Cache-Control': 'private, no-store',
    });
    for (const p of all) {
      const upstream = await blobs.get(p.blob_url).catch(() => null);
      if (!upstream) continue; // a missing piece is skipped; the rest still plays
      if (!(await pipeTo(ctx.res, upstream, { end: false }))) return; // the visitor left
    }
    ctx.res.end();
  });

  router.delete('/api/live/sessions/:id/transcript', (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    const audio = db.all('SELECT blob_url FROM live_recordings WHERE session_id = ?', s.id).map((r) => r.blob_url);
    if (audio.length && blobs.enabled) blobs.del(audio).catch(() => {});
    db.run('DELETE FROM live_recordings WHERE session_id = ?', s.id);
    db.run('DELETE FROM live_transcript WHERE session_id = ?', s.id);
    db.run('UPDATE live_sessions SET keep_transcript = 0 WHERE id = ?', s.id);
    transcripts.clear(s.id);
    return { ok: true };
  });

  /** One note of a lecture, to show full screen: a picture, a PDF (its pages) or, for other files, the text. */
  const noteOf = (s, noteId) => {
    const note = notesOf(s.id).find((n) => n.id === Number(noteId));
    if (!note) throw notFound('Note not found');
    return note;
  };
  const viewable = (n) => (n.kind === 'image' ? 'image' : n.mime === 'application/pdf' && n.data ? 'pdf' : 'text');

  router.get('/api/live/sessions/:id/notes/:noteId', (ctx) => {
    const n = noteOf(teaching(ctx.user, ctx.params.id), ctx.params.noteId);
    const how = viewable(n);
    return { id: n.id, kind: n.kind, name: n.name, mime: n.mime, viewable: how, ...(how === 'text' ? { text: n.text || '' } : {}) };
  });

  router.get('/api/live/sessions/:id/notes/:noteId/file', (ctx) => {
    const n = noteOf(teaching(ctx.user, ctx.params.id), ctx.params.noteId);
    if (viewable(n) === 'text') throw notFound('This note has no file to show');
    const bytes = Buffer.from(n.data, 'base64');
    // Shown inside the app (an iframe for PDFs), so this response may be framed by the app itself, and only by it.
    ctx.res.writeHead(200, {
      'Content-Type': n.kind === 'image' ? n.mime : 'application/pdf',
      'Content-Length': bytes.length,
      'Content-Disposition': `inline; filename="${n.name.replace(/[^\w. -]+/g, '_')}"`,
      'Cache-Control': 'private, max-age=3600',
      'X-Frame-Options': 'SAMEORIGIN',
      // Only framing is set here: a stricter policy on the PDF itself can stop the browser's PDF viewer from drawing it.
      'Content-Security-Policy': "frame-ancestors 'self'",
    });
    ctx.res.end(bytes);
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
    const seen = notesFor(s);
    const heard = transcripts.recent(s.id) || heardText(s, { from: minuteOf(s) - 8 });
    const system = liveAskPrompt({
      user, assistantName: assistantNameFor(user, site), course, title: s.title,
      minutesIn: Math.max(0, Math.round((Date.now() - Date.parse(s.started)) / 60000)),
      pulse: view.pulse, roughPatches: view.roughPatches, flags: view.flags,
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
    transcripts.clear(s.id); // the memory goes; a kept transcript stays in live_transcript
    moments.forget(s.id);
    if (s.lecture_id) db.run("UPDATE lectures SET status = 'ended', ends = CASE WHEN ends IS NULL OR ends > ? THEN ? ELSE ends END WHERE id = ?", isoNow(), isoNow(), s.lecture_id);
    const summary = lecturerView(sessionFor(ctx.user, s.id));
    puck({ ...s, ended: isoNow() }, summary.pulse);
    lastPuck.delete(s.id);
    bus.publish(`course:${s.course_id}`, 'live.ended', { session: s.id });
    return summary;
  });
}

module.exports = { register, byMinute };
