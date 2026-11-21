'use strict';
/**
 * Loads a lecture record (record.js) from the database, and finds the lecture a person is talking about in Ask
 * Citrus ("my last lecture", "the eigenvalues lecture"), so the general assistant can discuss a lecture too.
 *
 * Who gets what: the lecturer of the course gets everything (with the names of students who chose to show them);
 * a student gets only their own record, never the lecturer's words verbatim or other students.
 */
const { buildRecord, recordText } = require('./record');

function createRecordSource({ db, access, vault = null }) {
  const namedStudents = (sessionId) => new Map(db.all(
    'SELECT u.id, u.name, u.email FROM live_attendees a JOIN users u ON u.id = a.user_id WHERE a.session_id = ? AND a.share_name = 1 ORDER BY u.name',
    sessionId,
  ).map((r) => [r.id, { name: r.name, email: r.email }]));

  const notesOf = (sessionId) => db.all('SELECT a.name, a.text FROM live_notes n JOIN assistant_attachments a ON a.id = n.attachment_id WHERE n.session_id = ?', sessionId);

  /**
   * The record of a session for the lecturer, or for one student (`studentId`). `light` leaves out what was said
   * and the prepared notes, for overviews of many lectures that only need the results.
   */
  function load(session, { audience = 'lecturer', studentId = null, light = false, reader = null } = {}) {
    const student = audience === 'student';
    // What the lecturer said is sealed: only the lecturer who teaches the lecture (`reader`) can read it into a record.
    const open = !student && !light && session.keep_transcript && reader && vault ? vault.lecturer(session, reader) : null;
    return buildRecord({
      session,
      course: db.get('SELECT code, title FROM courses WHERE id = ?', session.course_id),
      audience,
      userId: studentId,
      names: student ? new Map() : namedStudents(session.id),
      lecturer: db.get('SELECT name FROM users WHERE id = ?', session.lecturer_id)?.name || '',
      enrolled: student ? 0 : db.get('SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?', session.course_id).n,
      transcript: student || light || !session.keep_transcript || (vault && !open) ? [] : db.all('SELECT text, created FROM live_transcript WHERE session_id = ? ORDER BY id', session.id).map((r) => (open ? { ...r, text: open(r.text) } : r)),
      // A student's record is built from their own rows only: other students' answers are never read for it.
      signals: student
        ? db.all('SELECT user_id, level, created FROM live_signals WHERE session_id = ? AND user_id = ? ORDER BY id', session.id, studentId)
        : db.all('SELECT user_id, level, created FROM live_signals WHERE session_id = ? ORDER BY id', session.id),
      flags: student
        ? db.all('SELECT user_id, kind, minute, note, explanation, created FROM live_flags WHERE session_id = ? AND user_id = ? ORDER BY id', session.id, studentId)
        : db.all('SELECT user_id, kind, minute, note, explanation, created FROM live_flags WHERE session_id = ? ORDER BY id', session.id),
      struggles: db.all("SELECT lost, unsure, answered, note, created FROM live_moments WHERE session_id = ? AND kind = 'struggle' ORDER BY id", session.id),
      points: db.all("SELECT note AS text, created FROM live_moments WHERE session_id = ? AND kind = 'point' ORDER BY id", session.id),
      notes: student || light ? [] : notesOf(session.id),
      breaks: db.all('SELECT started, ended FROM live_breaks WHERE session_id = ? ORDER BY started', session.id),
      chapters: db.all('SELECT id, started, title FROM live_chapters WHERE session_id = ? ORDER BY started, id', session.id),
    });
  }

  /**
   * The records of many sessions at once, for overviews of a term: results only (no transcript or notes), the
   * same as load(…, { light: true }) for each, but one query per kind of data for all of them instead of about
   * eight per session. Each query is a round trip to the hosted database, so this keeps a long term fast.
   */
  function loadMany(sessions, { audience = 'lecturer', studentId = null } = {}) {
    if (!sessions.length) return [];
    const student = audience === 'student';
    const ids = sessions.map((s) => s.id);
    const marks = (list) => list.map(() => '?').join(',');
    const group = (rows) => {
      const out = new Map(ids.map((i) => [i, []]));
      for (const { session_id: sid, ...row } of rows) out.get(sid)?.push(row);
      return out;
    };
    // For a student, only their own answers and flags are read (see load()).
    const own = student ? ' AND user_id = ?' : '';
    const ownArgs = student ? [studentId] : [];
    const signals = group(db.all(`SELECT session_id, user_id, level, created FROM live_signals WHERE session_id IN (${marks(ids)})${own} ORDER BY id`, ...ids, ...ownArgs));
    const flags = group(db.all(`SELECT session_id, user_id, kind, minute, note, explanation, created FROM live_flags WHERE session_id IN (${marks(ids)})${own} ORDER BY id`, ...ids, ...ownArgs));
    const moments = db.all(`SELECT session_id, kind, lost, unsure, answered, note, created FROM live_moments WHERE session_id IN (${marks(ids)}) AND kind IN ('struggle', 'point') ORDER BY id`, ...ids);
    const struggles = group(moments.filter((m) => m.kind === 'struggle').map(({ kind, ...m }) => m));
    const points = group(moments.filter((m) => m.kind === 'point').map((m) => ({ session_id: m.session_id, text: m.note, created: m.created })));
    const breaks = group(db.all(`SELECT session_id, started, ended FROM live_breaks WHERE session_id IN (${marks(ids)}) ORDER BY started`, ...ids));
    const chapters = group(db.all(`SELECT session_id, id, started, title FROM live_chapters WHERE session_id IN (${marks(ids)}) ORDER BY started, id`, ...ids));
    const named = new Map(ids.map((i) => [i, new Map()]));
    if (!student) {
      const rows = db.all(`SELECT a.session_id, u.id, u.name, u.email FROM live_attendees a JOIN users u ON u.id = a.user_id WHERE a.session_id IN (${marks(ids)}) AND a.share_name = 1 ORDER BY u.name`, ...ids);
      for (const r of rows) named.get(r.session_id).set(r.id, { name: r.name, email: r.email });
    }
    const courseIds = [...new Set(sessions.map((s) => s.course_id))];
    const courses = new Map(db.all(`SELECT id, code, title FROM courses WHERE id IN (${marks(courseIds)})`, ...courseIds).map((c) => [c.id, { code: c.code, title: c.title }]));
    const enrolled = new Map(student ? [] : db.all(`SELECT course_id, COUNT(*) AS n FROM enrollments WHERE course_id IN (${marks(courseIds)}) GROUP BY course_id`, ...courseIds).map((r) => [r.course_id, r.n]));
    const lecturerIds = [...new Set(sessions.map((s) => s.lecturer_id).filter(Boolean))];
    const lecturers = new Map(lecturerIds.length ? db.all(`SELECT id, name FROM users WHERE id IN (${marks(lecturerIds)})`, ...lecturerIds).map((u) => [u.id, u.name]) : []);
    return sessions.map((session) => buildRecord({
      session,
      course: courses.get(session.course_id),
      audience,
      userId: studentId,
      names: named.get(session.id),
      lecturer: lecturers.get(session.lecturer_id) || '',
      enrolled: enrolled.get(session.course_id) || 0,
      transcript: [],
      signals: signals.get(session.id),
      flags: flags.get(session.id),
      struggles: struggles.get(session.id),
      points: points.get(session.id),
      notes: [],
      breaks: breaks.get(session.id),
      chapters: chapters.get(session.id),
    }));
  }

  /** The lectures a person can talk about: the ones they teach, or the ones they took part in. Newest first. */
  function lecturesOf(user) {
    if (user.role === 'student') {
      return db.all(
        `SELECT s.* FROM live_sessions s WHERE s.institution_id = ? AND (EXISTS (SELECT 1 FROM live_attendees a WHERE a.session_id = s.id AND a.user_id = ?)
           OR EXISTS (SELECT 1 FROM live_signals g WHERE g.session_id = s.id AND g.user_id = ?)) ORDER BY s.id DESC LIMIT 40`,
        user.institution_id, user.id, user.id,
      );
    }
    return db.all('SELECT * FROM live_sessions WHERE institution_id = ? ORDER BY id DESC LIMIT 80', user.institution_id)
      .filter((s) => access.teachingCourse(user, s.course_id))
      .slice(0, 40);
  }

  const LAST = /\b(last|latest|previous|recent|today'?s|yesterday'?s|my)\s+(lecture|class|session|lesson)\b|\b(letzte[nrm]?|heutige[nrm]?|gestrige[nrm]?|meine[nrm]?)\s+(vorlesung|stunde|veranstaltung)\b/i;
  const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2);

  /**
   * The lecture this conversation is about: the one given by id (from a "continue in Ask Citrus" link), else one
   * named in the text by its title, else "my last lecture". Null when none.
   */
  function find(user, { id = null, text = '' } = {}) {
    const mine = lecturesOf(user);
    if (id) return mine.find((s) => s.id === Number(id)) || null;
    const said = new Set(words(text));
    let best = null;
    for (const s of mine) {
      const title = words(s.title);
      if (!title.length) continue;
      const hits = title.filter((w) => said.has(w)).length;
      const score = hits / title.length;
      if (hits >= Math.min(2, title.length) && score >= 0.6 && (!best || score > best.score)) best = { s, score };
    }
    if (best) return best.s;
    return LAST.test(text) ? mine.find((s) => s.ended) || mine[0] || null : null;
  }

  /** The record as text for the assistant's context, for this person. */
  function contextFor(user, session) {
    const lecturer = access.teachingCourse(user, session.course_id);
    const record = load(session, lecturer ? { audience: 'lecturer', reader: user } : { audience: 'student', studentId: user.id });
    return recordText({ ...record, notes: [] });
  }

  return { load, loadMany, find, contextFor, lecturesOf };
}

module.exports = { createRecordSource };
