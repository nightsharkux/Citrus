'use strict';
/**
 * Live lectures: the loop that makes Citrus useful in a lecture room.
 *
 *   The lecturer starts the lecture and shows a six-digit code. Students type it on their phones (that also joins
 *   the course), then tell the lecturer how they are following (following / unsure / lost) and flag moments they
 *   need help with ("didn't get this", "too fast", "need an example", a question, with an optional note). The
 *   lecturer sees the class pulse, a minute-by-minute timeline and the flags live, without names, and can ask
 *   Citrus things mid-lecture with the notes, what it heard and the flags as context. Students can ask Citrus
 *   about the lecture privately, during it and afterwards, and get each of their flags explained.
 *
 *   POST /api/live/sessions                     { course_id, lecture_id?, title?, notes?, keep_transcript? }  (lecturer)
 *   POST /api/live/join                         { code } or { token }  join the running lecture with its code, or
 *                                               the lecture with the link behind its QR code (links.js); before it
 *                                               starts that joins the course, and the lecture opens when it starts
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
 *   POST /api/live/sessions/:id/ai-notes        Citrus writes the notes from the record → { markdown, txt }
 *                                               (lecturer: notes and teaching review; student: study notes)
 *   POST /api/live/sessions/:id/review-chat     { message, history } → { answer }  improve it with Citrus (lecturer)
 *   DELETE /api/live/sessions/:id/transcript    forget the kept transcript                      (lecturer)
 *   POST /api/live/sessions/:id/notes           { attachment_ids }  add prepared notes          (lecturer)
 *   breaks, chapters and deleting parts of the recording: lecture-edits.js (pause, resume, chapters, …)
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
const { parsePptx } = require('../../lib/pptx-slides');
const { createTranscripts } = require('./transcript');
const { pulse, timeline, roughPatches, personalTimeline } = require('./pulse');
const { createMoments } = require('./moments');
const { buildFeed } = require('./lectures');
const { registerLinks, isToken, LECTURE_BY_TOKEN, RUNNING_BY_TOKEN } = require('./links');
const { registerLectureEdits } = require('./lecture-edits');
const { activeMs, shiftRows, totalBreakMs } = require('./breaks');

// The student is in the room: counted once. Whether they show their name starts as they chose in their last lecture.
const ARRIVE_SQL = 'INSERT OR IGNORE INTO live_attendees(session_id, user_id, joined, share_name) VALUES(?, ?, ?, COALESCE((SELECT CASE WHEN share_name THEN 1 ELSE 0 END FROM live_attendees WHERE user_id = ? ORDER BY joined DESC LIMIT 1), 0))';
const PRESENT_SQL = 'SELECT COUNT(*) AS n FROM live_attendees WHERE session_id = ?';

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

function register(router, { db, ai, access, bus, site, notifier, deviceCommands, vault, blobs = { enabled: false } }) {
  const attachments = createAttachments({ db });
  const transcripts = createTranscripts();
  const moments = createMoments({ db, ai, bus, transcripts, vault, minuteOf: (s) => minuteOf(s) });
  const links = registerLinks(router, { db, access }); // the QR code of each lecture
  const joinAttempts = createRateLimiter({ windowMs: 60_000, max: 12 });
  const notesWriting = createRateLimiter({ windowMs: 60_000, max: 4 });
  const isoNow = () => new Date().toISOString();
  let edits = null; // chapters, breaks and recording edits (lecture-edits.js), registered below
  /** The breaks of a lecture ([{ started, ended }]). Read when needed: another instance may have changed them. */
  const breaksOf = (sessionId) => db.all('SELECT started, ended FROM live_breaks WHERE session_id = ? ORDER BY started', sessionId);
  /** The minute of the lecture an instant falls in, in teaching time: a break is not counted. */
  const minuteOf = (s, at = Date.now()) => Math.max(1, Math.ceil(activeMs(s.started, breaksOf(s.id), at) / 60_000));
  /** The lecture's clock for timelines: rows moved back by the break time before them, and "now" in teaching time. */
  function clockOf(s, breaks = breaksOf(s.id)) {
    const nowMs = Date.now();
    const endMs = s.ended ? Date.parse(s.ended) : nowMs;
    return { breaks, shift: (rows) => shiftRows(rows, breaks, nowMs), now: Date.parse(s.started) + activeMs(s.started, breaks, endMs, nowMs) };
  }
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
    const s = joined(user, sessionId); // for a student, joining the course already means being enrolled in it
    if (user.role !== 'student') throw forbidden('Only students of this course can do this');
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
   * What Citrus reads as the lecture's notes: the files the lecturer added to the lecture, plus the readable files
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

  // paused / pausedAt / breakMs let every screen keep the lecture's clock without counting its breaks.
  const publicSession = (s, breaks) => ({ id: s.id, course_id: s.course_id, lecture_id: s.lecture_id, title: s.title, started: s.started, ended: s.ended, keepTranscript: !!s.keep_transcript, paused: !!s.paused_at, pausedAt: s.paused_at || null, breakMs: totalBreakMs((breaks || breaksOf(s.id)).filter((b) => b.ended)) });
  const listening = (s) => !s.ended && Date.now() - transcripts.lastAt(s.id) < LISTENING_MS;

  /**
   * The stored lines are sealed (vault.js). They are opened only through one of two doors: `forLecturer` for the
   * lecturer who teaches the lecture, and `forAi` as input to a model request that writes something for a student
   * (the words themselves never go back to the student).
   */
  const forAi = (s) => (stored) => vault.forAi(s, stored);

  /** What Citrus heard: the stored transcript when kept (by minute), otherwise the last minutes in memory. `open` opens the sealed lines. */
  function heardText(s, { from = 0, to = Infinity, maxChars = TRANSCRIPT_FOR_AI, open } = {}) {
    if (s.keep_transcript) {
      const rows = db.all('SELECT minute, text FROM live_transcript WHERE session_id = ? AND minute >= ? AND minute <= ? ORDER BY id', s.id, from, Number.isFinite(to) ? to : 100_000)
        .map((r) => ({ ...r, text: open(r.text) }));
      if (rows.length) return byMinute(rows, maxChars);
    }
    return transcripts.recent(s.id, { minutes: 10, maxChars });
  }

  /** What was said (stored lines only) inside the given parts of a lecture, as one text. Nothing outside them. */
  function heardInTargets(s, parts, maxChars) {
    const texts = [];
    for (const part of parts) {
      const rows = db.all('SELECT minute, text FROM live_transcript WHERE session_id = ? AND minute >= ? AND minute <= ? ORDER BY id', s.id, Math.floor(part.from / 60), Math.ceil(part.to / 60) + 1)
        .map((r) => ({ ...r, text: forAi(s)(r.text) }));
      if (rows.length) texts.push(byMinute(rows, Math.floor(maxChars / Math.max(1, parts.length))));
    }
    return texts.join('\n').slice(0, maxChars);
  }

  function livePulse(s) {
    return pulse(signalsOf(s.id), { enrolled: enrolledCount(s.course_id) });
  }

  /**
   * The class status on the Citrus Puck (and any door light or display) in the lecture's room: green, amber or red,
   * so the lecturer sees at a glance when to explain again. Sent only when the status changes. Counts only.
   */
  const lastPuck = new Map();
  function puck(s, p, knownRoom) {
    if (!deviceCommands) return 0;
    const room = knownRoom !== undefined ? knownRoom : s.lecture_id ? db.get('SELECT room FROM lectures WHERE id = ?', s.lecture_id)?.room : '';
    const status = s.ended ? 'off' : p.status;
    if (!room || lastPuck.get(s.id) === status) return 0;
    lastPuck.set(s.id, status);
    return deviceCommands.toRoom(s.institution_id, room, 'class.pulse', { session: s.id, status, following: p.following, unsure: p.unsure, lost: p.lost, answered: p.answered });
  }

  /**
   * Tell the lecturer's open screens that the pulse moved. Anonymous aggregates only. The first answer is announced
   * at once; answers that follow within ANNOUNCE_GAP_MS are announced together (one recount instead of one per
   * student: thirty students answering at once would otherwise recount thirty times).
   */
  const ANNOUNCE_GAP_MS = 1_500;
  const announcing = new Map(); // session id → { at, timer }
  function announceNow(s) {
    // The answers, the class size and the room in one round trip.
    const [signals, enrolledRows, roomRows] = db.batch([
      ['SELECT user_id, level, created FROM live_signals WHERE session_id = ? ORDER BY id', s.id],
      ['SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?', s.course_id],
      ['SELECT room FROM lectures WHERE id = ?', s.lecture_id || 0],
    ]);
    const p = pulse(signals, { enrolled: enrolledRows[0].n });
    bus.publish(`user:${s.lecturer_id}`, 'live.pulse', { session: s.id, pulse: p });
    puck(s, p, roomRows[0]?.room || '');
    moments.onPulse(s, p); // when the class tips into trouble, keep that moment for the lecturer's review
  }
  function announce(s) {
    const state = announcing.get(s.id) || { at: 0, timer: null };
    announcing.set(s.id, state);
    if (state.timer) return; // one is already waiting and will count this answer too
    const wait = state.at + ANNOUNCE_GAP_MS - Date.now();
    if (wait <= 0) {
      state.at = Date.now();
      announceNow(s);
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      state.at = Date.now();
      try {
        announceNow(sessionRow(s.id) || s);
      } catch (error) {
        console.error('Could not announce the class pulse:', error.message);
      }
    }, wait);
    state.timer.unref?.();
  }
  const sessionRow = (sessionId) => db.get('SELECT * FROM live_sessions WHERE id = ?', sessionId);

  /**
   * The lecturer's screen, refreshed whenever the class answers: everything in one round trip to the database, and
   * the notes by name only (their contents are fetched when one is opened).
   */
  function lecturerView(s) {
    const [signals, flags, enrolledRows, notes, presentRows, storedRows, tokenRows, breakRows, chapterRows] = db.batch([
      ['SELECT user_id, level, created FROM live_signals WHERE session_id = ? ORDER BY id', s.id],
      ['SELECT id, kind, minute, note, created FROM live_flags WHERE session_id = ? ORDER BY id', s.id],
      ['SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?', s.course_id],
      ['SELECT a.id, a.kind, a.name, a.mime, a.size FROM live_notes n JOIN assistant_attachments a ON a.id = n.attachment_id WHERE n.session_id = ?', s.id],
      ['SELECT COUNT(*) AS n FROM live_attendees WHERE session_id = ?', s.id],
      ['SELECT COUNT(*) AS n FROM live_transcript WHERE session_id = ?', s.id],
      ['SELECT join_token FROM lectures WHERE id = ?', s.lecture_id || 0],
      ['SELECT started, ended FROM live_breaks WHERE session_id = ? ORDER BY started', s.id],
      ['SELECT id, started, title FROM live_chapters WHERE session_id = ? ORDER BY started, id', s.id],
    ]);
    const clock = clockOf(s, breakRows);
    const line = timeline(clock.shift(signals), s.started, { now: clock.now });
    const token = tokenRows[0]?.join_token;
    // The QR code opens the lecture's own link (the same on a slide made before); old sessions have only the code.
    const joinLink = !s.lecture_id ? `/join/${s.join_code}` : token ? `/join/${token}` : links.pathFor(s.lecture_id);
    return {
      session: { ...publicSession(s, breakRows), joinCode: s.ended ? null : s.join_code, joinLink },
      pulse: pulse(signals, { enrolled: enrolledRows[0].n }),
      timeline: line,
      roughPatches: roughPatches(line),
      notes,
      flags: flags.slice(-60).map(({ id: flagId, kind, minute, note }) => ({ id: flagId, kind, minute, note })),
      flagCounts: flagCounts(flags),
      present: presentRows[0].n,
      heard: transcripts.size(s.id),
      stored: s.keep_transcript ? storedRows[0].n : 0,
      listening: listening(s),
      chapters: edits ? edits.chaptersOf(s, { rows: chapterRows, breaks: breakRows }) : [],
    };
  }

  /**
   * The student's screen in one round trip. `arriving` also counts them in the room the first time (arrive()),
   * writing only when they are not counted yet.
   */
  function studentView(s, user, { arriving = false } = {}) {
    const [mineRows, flags, presentRows, noteRows, hereRows, lastRows] = db.batch([
      ['SELECT level, created FROM live_signals WHERE session_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', s.id, user.id],
      ['SELECT id, kind, minute, note, explanation, created FROM live_flags WHERE session_id = ? AND user_id = ? ORDER BY id', s.id, user.id],
      ['SELECT COUNT(*) AS n FROM live_attendees WHERE session_id = ?', s.id],
      ['SELECT COUNT(*) AS n FROM live_notes WHERE session_id = ?', s.id],
      ['SELECT share_name FROM live_attendees WHERE session_id = ? AND user_id = ?', s.id, user.id],
      ['SELECT share_name FROM live_attendees WHERE user_id = ? ORDER BY joined DESC LIMIT 1', user.id],
    ]);
    let present = presentRows[0].n;
    let here = hereRows[0] || null;
    if (arriving && !here && !s.ended && user.role === 'student') {
      const share = lastRows[0]?.share_name ? 1 : 0;
      const r = db.run('INSERT OR IGNORE INTO live_attendees(session_id, user_id, joined, share_name) VALUES(?, ?, ?, ?)', s.id, user.id, isoNow(), share);
      if (r?.changes) {
        present += 1;
        bus.publish(`user:${s.lecturer_id}`, 'live.presence', { session: s.id, present });
      }
      here = { share_name: share };
    }
    return { session: publicSession(s), mine: mineRows[0] || null, flags, listening: listening(s), minute: minuteOf(s), present, notes: noteRows[0].n, shareName: !!here?.share_name };
  }

  /**
   * The student is in the room: counted for the lecturer, once. Whether they show their name starts as they chose
   * in their last lecture.
   */
  function arrive(s, user) {
    if (s.ended || user.role !== 'student') return;
    // One statement: whether to show their name starts as they chose in their last lecture.
    const r = db.run(ARRIVE_SQL, s.id, user.id, isoNow(), user.id);
    if (r?.changes) bus.publish(`user:${s.lecturer_id}`, 'live.presence', { session: s.id, present: presentCount(s.id) });
  }
  const sharesName = (sessionId, userId) => !!db.get('SELECT share_name FROM live_attendees WHERE session_id = ? AND user_id = ?', sessionId, userId)?.share_name;

  /** Students who chose to show their name in this lecture: id → { name, email }. */
  function namedStudents(sessionId) {
    const rows = db.all('SELECT u.id, u.name, u.email FROM live_attendees a JOIN users u ON u.id = a.user_id WHERE a.session_id = ? AND a.share_name = 1 ORDER BY u.name', sessionId);
    return new Map(rows.map((r) => [r.id, { name: r.name, email: r.email }]));
  }

  // ---- routes ----------------------------------------------------------------------------------------------

  edits = registerLectureEdits(router, { db, bus, blobs, transcripts, teaching, lecturerView, breaksOf });

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
    // Keeping the transcript is the default: it is what lets Citrus answer about the lecture afterwards.
    const keep = b.keep_transcript === false ? 0 : b.keep_transcript === true || !previous ? 1 : previous.keep_transcript;
    const sessionId = db.insert(
      'INSERT INTO live_sessions(institution_id, course_id, lecturer_id, lecture_id, title, started, join_code, keep_transcript) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      user.institution_id, course.id, user.id, lecture.id, title, isoNow(), joinCodeFor(user.institution_id, lecture.id), keep,
    );
    // The first chapter starts with the lecture; the Chapter button adds the next ones.
    db.run("INSERT INTO live_chapters(session_id, started, title, created) SELECT id, started, '', started FROM live_sessions WHERE id = ?", sessionId);
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
    if (b.token !== undefined) return joinByLinkAsync(user, b.token);
    const code = String(b.code ?? '').replace(/\D/g, '');
    if (code.length !== 6) throw badRequest('The code has six digits');
    const s = db.get('SELECT * FROM live_sessions WHERE institution_id = ? AND join_code = ? AND ended IS NULL ORDER BY id DESC LIMIT 1', user.institution_id, code);
    if (!s) throw notFound('No lecture is running with that code. Check the screen.');
    if (user.role === 'student') db.run('INSERT OR IGNORE INTO enrollments(course_id, user_id) VALUES(?, ?)', s.course_id, user.id);
    else if (!access.course(user, s.course_id)) throw forbidden('This code is for students of the course');
    arrive(s, user);
    return { session: s.id, course_id: s.course_id, title: s.title, live: true };
  });

  /**
   * The QR code of a lecture: join it now when it is live. Before it starts (a code on a slide or a sheet) the
   * student joins the course, so the lecture opens on their phone by itself when it starts.
   */
  function joinByLink(user, token) {
    const lecture = isToken(token) ? links.lectureOf(token) : null;
    if (!lecture || lecture.institution_id !== user.institution_id) throw notFound('This QR code no longer works. Ask your lecturer for the current one.');
    if (user.role === 'student') db.run('INSERT OR IGNORE INTO enrollments(course_id, user_id) VALUES(?, ?)', lecture.course_id, user.id);
    else if (!access.course(user, lecture.course_id)) throw forbidden('This QR code is for students of the course');
    const s = links.runningOf(lecture.id);
    if (s) arrive(s, user);
    return { session: s?.id || null, course_id: lecture.course_id, title: s?.title || lecture.topic, live: !!s };
  }

  /** joinByLink() without blocking the server while the database answers: two round trips, however many join at once. */
  async function joinByLinkAsync(user, token) {
    const gone = () => notFound('This QR code no longer works. Ask your lecturer for the current one.');
    if (!isToken(token)) throw gone();
    const [lectures, courses, running] = await db.batchAsync([
      [LECTURE_BY_TOKEN, String(token)],
      ['SELECT * FROM courses WHERE id = (SELECT course_id FROM lectures WHERE join_token = ?)', String(token)],
      [RUNNING_BY_TOKEN, String(token)],
    ]);
    const lecture = lectures[0];
    if (!lecture || lecture.institution_id !== user.institution_id) throw gone();
    const s = running[0] || null;
    if (user.role !== 'student') {
      if (!access.teaches(user, courses[0])) throw forbidden('This QR code is for students of the course');
    } else {
      const writes = [['INSERT OR IGNORE INTO enrollments(course_id, user_id) VALUES(?, ?)', lecture.course_id, user.id]];
      if (s) writes.push([ARRIVE_SQL, s.id, user.id, isoNow(), user.id], [PRESENT_SQL, s.id]);
      const out = await db.batchAsync(writes);
      if (s) bus.publish(`user:${s.lecturer_id}`, 'live.presence', { session: s.id, present: out.at(-1)[0].n });
    }
    return { session: s?.id || null, course_id: lecture.course_id, title: s?.title || lecture.topic, live: !!s };
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
    if (user.role !== 'lecturer' && user.role !== 'admin') return { running: [], courses: [] };
    const courses = db.all(
      `SELECT id, code, title FROM courses WHERE institution_id = ? AND (lecturer_id = ? OR ? = 'admin') ORDER BY code LIMIT 60`,
      user.institution_id, user.id, user.role,
    );
    // The running lecture of each course in one query, not one per course.
    const running = new Map(courses.length ? db.all(
      `SELECT course_id, MAX(id) AS id FROM live_sessions WHERE ended IS NULL AND course_id IN (${courses.map(() => '?').join(',')}) GROUP BY course_id`,
      ...courses.map((c) => c.id),
    ).map((r) => [r.course_id, r.id]) : []);
    return { running: [], courses: courses.map((c) => ({ ...c, running: running.get(c.id) || null })) };
  });

  /**
   * After the lecture, for its lecturer: where it went wrong. The class timeline, the stretches of trouble, what was
   * being said at each one with a note on the likely sticking point, the flags, and the key points.
   */
  router.get('/api/live/sessions/:id/report', (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    const course = db.get('SELECT id, code, title FROM courses WHERE id = ?', s.course_id);
    const open = vault.lecturer(s, ctx.user); // checks once that this is the lecturer who teaches it
    const flags = flagsOf(s.id).map((f) => ({ ...f, excerpt: s.keep_transcript ? heardText(s, { from: f.minute - 1, to: f.minute, maxChars: 500, open }) : '' }));
    return { ...lecturerView(s), flags, course, ...moments.list(s.id, { open }), answeredBy: new Set(signalsOf(s.id).map((x) => x.user_id)).size, record: recordSummary(recordOf(ctx.user, s, 'lecturer'), { detail: true }), recording: keptAudio(s) };
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
    const clock = clockOf(s);
    // Their own answers only: what the rest of the class answered is not read for a student's page.
    const mine = db.all('SELECT user_id, level, created FROM live_signals WHERE session_id = ? AND user_id = ? ORDER BY id', s.id, ctx.user.id);
    const taught = moments.list(s.id, { excerpts: false });
    const flags = db.all('SELECT id, kind, minute, note, explanation FROM live_flags WHERE session_id = ? AND user_id = ? ORDER BY id', s.id, ctx.user.id);
    // A student gets no summary of the lecture: only what belongs to the parts they struggled with (their own
    // answers and flags decide which). The lecturer's key points and trouble-spot notes for every other part stay
    // with the lecturer.
    const record = recordSummary(recordOf(ctx.user, s, 'student'), { detail: true });
    const target = record.sections.filter((x) => x.target);
    const inTarget = (minute) => target.some((x) => (minute - 1) * 60 >= x.from && (minute - 1) * 60 < Math.max(x.to, x.from + 60));
    const struggles = taught.struggles.filter((m) => inTarget(m.minute));
    const points = taught.points.filter((m) => inTarget(m.minute));
    return {
      session: publicSession(s), course,
      mine: personalTimeline(clock.shift(mine), s.started, { now: clock.now }),
      classPatches: [],
      // No counts of how many students were lost: only the moment and Citrus's note on it.
      struggles: struggles.map(({ minute, note }) => ({ minute, note })),
      points,
      flags,
      signals: mine.length,
      // Citrus can answer about this lecture when it kept what it heard.
      canAsk: !!s.keep_transcript && storedLines(s.id) > 0,
      // Their own results, section by section: what to work on. It holds nothing about the class.
      record,
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

  /**
   * The lecture of a course that is running now, and for a student their own screen of it (also counting them in the
   * room the first time). One round trip to the database, without blocking the server: a whole class opens this at
   * once, and again every few seconds while waiting for the lecture to start.
   */
  router.get('/api/live/courses/:id/active', async (ctx) => {
    const user = ctx.user;
    const courseId = id(ctx.params.id, 'Course');
    const running = '(SELECT id FROM live_sessions WHERE course_id = ? AND ended IS NULL ORDER BY id DESC LIMIT 1)';
    const [courseRows, sessionRows, mineRows, flags, presentRows, noteRows, hereRows] = await db.batchAsync([
      [`${access.COURSE_ACCESS_SQL}c.id = ? AND c.institution_id = ?`, user.id, courseId, user.institution_id],
      ['SELECT * FROM live_sessions WHERE course_id = ? AND ended IS NULL ORDER BY id DESC LIMIT 1', courseId],
      [`SELECT level, created FROM live_signals WHERE session_id = ${running} AND user_id = ? ORDER BY id DESC LIMIT 1`, courseId, user.id],
      [`SELECT id, kind, minute, note, explanation, created FROM live_flags WHERE session_id = ${running} AND user_id = ? ORDER BY id`, courseId, user.id],
      [`SELECT COUNT(*) AS n FROM live_attendees WHERE session_id = ${running}`, courseId],
      [`SELECT COUNT(*) AS n FROM live_notes WHERE session_id = ${running}`, courseId],
      [`SELECT share_name FROM live_attendees WHERE session_id = ${running} AND user_id = ?`, courseId, user.id],
    ]);
    const course = access.courseFromRow(user, courseRows[0]);
    if (!course) throw forbidden('Join this course first');
    const head = { id: course.id, code: course.code, title: course.title };
    const s = sessionRows[0];
    if (!s) return { session: null, course: head };
    if (access.teaches(user, course)) return { session: publicSession(s), course: head };
    let present = presentRows[0].n;
    let here = hereRows[0] || null;
    if (!here && !s.ended && user.role === 'student') {
      const [, count, mine] = await db.batchAsync([
        [ARRIVE_SQL, s.id, user.id, isoNow(), user.id],
        [PRESENT_SQL, s.id],
        ['SELECT share_name FROM live_attendees WHERE session_id = ? AND user_id = ?', s.id, user.id],
      ]);
      present = count[0].n;
      here = mine[0] || null;
      bus.publish(`user:${s.lecturer_id}`, 'live.presence', { session: s.id, present });
    }
    return { session: publicSession(s), course: head, mine: mineRows[0] || null, flags, listening: listening(s), minute: minuteOf(s), present, notes: noteRows[0].n, shareName: !!here?.share_name };
  });

  router.get('/api/live/sessions/:id', (ctx) => {
    const s = sessionFor(ctx.user, ctx.params.id);
    const course = access.course(ctx.user, s.course_id);
    if (!course) throw forbidden('Join this course first');
    return access.teaches(ctx.user, course) ? lecturerView(s) : studentView(s, ctx.user);
  });

  // Without blocking the server while the database answers, in two round trips: a whole class answers together.
  router.post('/api/live/sessions/:id/signal', async (ctx) => {
    const user = ctx.user;
    const sessionId = id(ctx.params.id, 'Lecture');
    const [sessionRows, courseRows, lastRows] = await db.batchAsync([
      ['SELECT * FROM live_sessions WHERE id = ? AND institution_id = ?', sessionId, user.institution_id],
      [`${access.COURSE_ACCESS_SQL}c.id = (SELECT course_id FROM live_sessions WHERE id = ?) AND c.institution_id = ?`, user.id, sessionId, user.institution_id],
      ['SELECT created FROM live_signals WHERE session_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', sessionId, user.id],
    ]);
    const s = sessionRows[0];
    if (!s) throw notFound('Lecture not found');
    if (!access.courseFromRow(user, courseRows[0])) throw forbidden('Join this course first');
    if (user.role !== 'student') throw forbidden('Only students of this course can do this');
    if (s.ended) throw conflict('This lecture has ended');
    if (s.paused_at) throw conflict('The lecture is on a break. You can answer when it continues.');
    const b = await ctx.json();
    const level = integer(b.level, { min: 1, max: 3, label: 'Signal' });
    const last = lastRows[0];
    if (last && Date.now() - Date.parse(last.created) < SIGNAL_GAP_MS) throw conflict('Wait a few seconds before changing your answer.');
    const created = isoNow();
    const out = await db.batchAsync([
      ['INSERT INTO live_signals(session_id, user_id, level, created) VALUES(?, ?, ?, ?)', s.id, user.id, level, created],
      [ARRIVE_SQL, s.id, user.id, isoNow(), user.id],
      [PRESENT_SQL, s.id],
    ]);
    bus.publish(`user:${s.lecturer_id}`, 'live.presence', { session: s.id, present: out[2][0].n });
    announce(s);
    return { level, label: LEVELS[level], created };
  });

  /** A student marks this moment of the lecture. The lecturer sees it straight away, without the student's name. */
  router.post('/api/live/sessions/:id/flags', async (ctx) => {
    const user = ctx.user;
    const s = attending(user, ctx.params.id);
    if (s.ended) throw conflict('This lecture has ended');
    if (s.paused_at) throw conflict('The lecture is on a break. You can flag a moment when it continues.');
    const b = await ctx.json();
    const kind = oneOf(b.kind, FLAG_KINDS, 'Flag');
    const note = text(b.note, { max: 240, optional: true, label: 'Note' }) || '';
    const mine = db.all('SELECT created FROM live_flags WHERE session_id = ? AND user_id = ? ORDER BY id DESC', s.id, user.id);
    if (mine.length >= MAX_FLAGS) throw conflict('You have flagged a lot already. Ask Citrus instead, or talk to your lecturer after class.');
    if (mine[0] && Date.now() - Date.parse(mine[0].created) < FLAG_GAP_MS) throw conflict('Wait a few seconds before flagging again.');
    const minute = minuteOf(s);
    const created = isoNow();
    const flagId = db.insert('INSERT INTO live_flags(session_id, user_id, kind, minute, note, created) VALUES(?, ?, ?, ?, ?, ?)', s.id, user.id, kind, minute, note, created);
    arrive(s, user);
    bus.publish(`user:${s.lecturer_id}`, 'live.flag', { session: s.id, flag: { id: flagId, kind, minute, note } });
    ctx.status = 201;
    return { id: flagId, kind, minute, note, created, explanation: '' };
  });

  /** Citrus explains one of the student's flags from what was said around it. Kept, so the recap shows it again. */
  router.post('/api/live/sessions/:id/flags/:flagId/explain', async (ctx) => {
    const user = ctx.user;
    const s = joined(user, ctx.params.id);
    const flag = db.get('SELECT * FROM live_flags WHERE id = ? AND session_id = ? AND user_id = ?', id(ctx.params.flagId, 'Flag'), s.id, user.id);
    if (!flag) throw notFound('Flag not found');
    if (flag.explanation) return { id: flag.id, explanation: flag.explanation };
    if (!ai.status(user).aiEnabled) throw unavailable('The assistant is not connected yet.');
    const seen = notesFor(s);
    const heard = heardText(s, { from: flag.minute - 4, to: flag.minute + 1, maxChars: 6000, open: forAi(s) });
    const turn = { text: [`<TRANSCRIPT>\n${heard || '(nothing was heard around this minute)'}\n</TRANSCRIPT>`, ...seen.blocks].join('\n\n'), images: seen.images };
    const explanation = String(await ai.complete({ user, system: liveFlagExplainPrompt({ kind: flag.kind, note: flag.note, minute: flag.minute, language: language(user) }), prompt: turn, maxTokens: 600, task: 'search' })).trim();
    db.run('UPDATE live_flags SET explanation = ? WHERE id = ?', explanation.slice(0, 4000), flag.id);
    return { id: flag.id, explanation, heard: !!heard };
  });

  /** A student asks about the lecture, privately: from what Citrus heard, the notes and their own flags. */
  router.post('/api/live/sessions/:id/student-ask', async (ctx) => {
    const user = ctx.user;
    const s = attending(user, ctx.params.id);
    const b = await ctx.json();
    const question = text(b.question, { min: 2, max: 600, label: 'Question' });
    if (!ai.status(user).aiEnabled) throw unavailable('The assistant is not connected yet.');
    const course = db.get('SELECT code, title FROM courses WHERE id = ?', s.course_id);
    const seen = notesFor(s);
    // While the lecture is running a student may ask about what was just said (they are in the room). Afterwards
    // Citrus is given only what was said in the parts they struggled with, never the whole lecture.
    const heard = s.ended
      ? (s.keep_transcript ? heardInTargets(s, recordSummary(recordOf(user, s, 'student')).sections.filter((x) => x.target), TRANSCRIPT_FOR_AI) : '')
      : heardText(s, { from: minuteOf(s) - 10, open: forAi(s) });
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
    if (s.paused_at) return { lines: 0, paused: true }; // a break: nothing is kept
    const b = await ctx.json();
    const line = text(b.text, { min: 1, max: 600, label: 'Text' });
    const lines = transcripts.add(s.id, line);
    if (s.keep_transcript) db.run('INSERT INTO live_transcript(session_id, minute, text, created) VALUES(?, ?, ?, ?)', s.id, minuteOf(s), vault.seal(s.id, line.replace(/\s+/g, ' ').trim()), isoNow());
    moments.onSpeech(s); // every few minutes: the key points of what was just said
    return { lines };
  });

  // ---- the lecture record (record.js): every result tagged with its second and section --------------------

  const audienceOf = (user, s) => (access.teachingCourse(user, s.course_id) ? 'lecturer' : 'student');

  /** Everything that happened in the lecture, as the record for the lecturer or for one student. */
  const records = createRecordSource({ db, access, vault });
  const recordOf = (user, s, audience, { studentId = user.id } = {}) => records.load(s, { audience, studentId, reader: audience === 'lecturer' ? user : null });
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
   * Citrus's quick take for the lecturer: the few points worth discussing or acting on, each tied to its time and
   * part, before the full notes or a conversation.
   */
  router.post('/api/live/sessions/:id/quick-take', async (ctx) => {
    const user = ctx.user;
    const s = teaching(user, ctx.params.id);
    if (!ai.status(user).aiEnabled) throw unavailable('The assistant is not connected yet.');
    if (!notesWriting.hit(user.id)) throw tooMany('Citrus is still thinking. Wait a minute and try again.');
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
   * Citrus writes the notes from the record, following the same instructions any AI gets. Nothing is stored: the
   * phone downloads the PDF and the .txt. For a student, Citrus may read what was said to explain it, but their
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
    if (!notesWriting.hit(user.id)) throw tooMany('Citrus is still writing. Wait a minute and try again.');
    const record = recordOf(user, s, audience, { studentId: forStudent || user.id });
    const seen = notesFor(s);
    // For a student, Citrus may read what was said only in the parts they struggled with, never the whole lecture.
    const heard = audience === 'student' && s.keep_transcript
      ? heardInTargets(s, record.sections.filter((x) => x.target), 30_000)
      : '';
    const prompt = {
      text: [`<RECORD>\n${recordText({ ...record, notes: [] }).slice(0, 110_000)}\n</RECORD>`, heard ? `<TRANSCRIPT>\n${heard}\n</TRANSCRIPT>` : '', ...seen.blocks].filter(Boolean).join('\n\n'),
      images: seen.images,
    };
    const system = lectureNotesPrompt({ audience, language: language(user), assistantName: assistantNameFor(user, site), title: s.title, course: record.meta.course });
    const markdown = String(await ai.complete({ user, system, prompt, maxTokens: 5000, task: 'chat' })).trim();
    if (!markdown) throw unavailable('Citrus could not write the notes this time. Try again.');
    const who = forStudent ? namedStudents(s.id).get(forStudent)?.name || 'student' : '';
    const name = `${fileBase(s)}-${forStudent ? `notes-for-${who.replace(/[^\w-]+/g, '-')}` : audience === 'student' ? 'my-notes' : 'lecture-notes'}`;
    return {
      audience, name, markdown,
      record: recordSummary(record),
      txt: recordText(record, { extra: `=== NOTES WRITTEN BY CAMPUS (Markdown) ===\n${markdown}` }),
    };
  });

  /**
   * The lecturer and Citrus talk about the lecture in its review: why an explanation did not land, how to say it
   * better, improved notes for next time. Citrus has the whole record. The conversation stays on the lecturer's
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
    if (s.paused_at) return { lines: 0, text: [], paused: true }; // a break: the background recording may still be running; nothing is kept
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
      if (s.keep_transcript) db.run('INSERT INTO live_transcript(session_id, minute, text, created) VALUES(?, ?, ?, ?)', s.id, minuteOf(s, Date.parse(line.created)), vault.seal(s.id, line.text), line.created);
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
  const viewable = (n) => (n.kind === 'image' ? 'image' : n.mime === 'application/pdf' && n.data ? 'pdf' : n.data && /\.pptx$/i.test(n.name) ? 'slides' : 'text');
  // A deck is read once per note: the slides (with their pictures) can be a few megabytes.
  const decks = new Map();

  router.get('/api/live/sessions/:id/notes/:noteId', (ctx) => {
    const n = noteOf(teaching(ctx.user, ctx.params.id), ctx.params.noteId);
    const how = viewable(n);
    return { id: n.id, kind: n.kind, name: n.name, mime: n.mime, viewable: how, ...(how === 'text' ? { text: n.text || '' } : {}) };
  });

  /** A PowerPoint note drawn as slides (pictures, text boxes, colours). Speaker notes come with each slide, for the lecturer only. */
  router.get('/api/live/sessions/:id/notes/:noteId/slides', (ctx) => {
    const n = noteOf(teaching(ctx.user, ctx.params.id), ctx.params.noteId);
    if (viewable(n) !== 'slides') throw notFound('This note has no slides to show');
    if (!decks.has(n.id)) {
      if (decks.size > 8) decks.delete(decks.keys().next().value);
      try {
        decks.set(n.id, parsePptx(Buffer.from(n.data, 'base64')));
      } catch (error) {
        throw badRequest(error.message || 'These slides cannot be shown');
      }
    }
    return decks.get(n.id);
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
    const heard = transcripts.recent(s.id) || heardText(s, { from: minuteOf(s) - 8, open: vault.lecturer(s, user) });
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
    if (!s.ended) {
      // Ending during a break ends the break with it.
      const at = isoNow();
      db.run('UPDATE live_breaks SET ended = ? WHERE session_id = ? AND ended IS NULL', at, s.id);
      db.run('UPDATE live_sessions SET ended = ?, paused_at = NULL WHERE id = ?', at, s.id);
    }
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
