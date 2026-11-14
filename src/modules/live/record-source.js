'use strict';
/**
 * Loads a lecture record (record.js) from the database, and finds the lecture a person is talking about in Ask
 * Campus ("my last lecture", "the eigenvalues lecture"), so the general assistant can discuss a lecture too.
 *
 * Who gets what: the lecturer of the course gets everything (with the names of students who chose to show them);
 * a student gets only their own record, never the lecturer's words verbatim or other students.
 */
const { buildRecord, recordText } = require('./record');

function createRecordSource({ db, access }) {
  const namedStudents = (sessionId) => new Map(db.all(
    'SELECT u.id, u.name, u.email FROM live_attendees a JOIN users u ON u.id = a.user_id WHERE a.session_id = ? AND a.share_name = 1 ORDER BY u.name',
    sessionId,
  ).map((r) => [r.id, { name: r.name, email: r.email }]));

  const notesOf = (sessionId) => db.all('SELECT a.name, a.text FROM live_notes n JOIN assistant_attachments a ON a.id = n.attachment_id WHERE n.session_id = ?', sessionId);

  /** The record of a session for the lecturer, or for one student (`studentId`). */
  function load(session, { audience = 'lecturer', studentId = null } = {}) {
    const student = audience === 'student';
    return buildRecord({
      session,
      course: db.get('SELECT code, title FROM courses WHERE id = ?', session.course_id),
      audience,
      userId: studentId,
      names: student ? new Map() : namedStudents(session.id),
      lecturer: db.get('SELECT name FROM users WHERE id = ?', session.lecturer_id)?.name || '',
      enrolled: db.get('SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?', session.course_id).n,
      transcript: student || !session.keep_transcript ? [] : db.all('SELECT text, created FROM live_transcript WHERE session_id = ? ORDER BY id', session.id),
      signals: db.all('SELECT user_id, level, created FROM live_signals WHERE session_id = ? ORDER BY id', session.id),
      flags: db.all('SELECT user_id, kind, minute, note, explanation, created FROM live_flags WHERE session_id = ? ORDER BY id', session.id),
      struggles: db.all("SELECT lost, unsure, answered, note, created FROM live_moments WHERE session_id = ? AND kind = 'struggle' ORDER BY id", session.id),
      points: db.all("SELECT note AS text, created FROM live_moments WHERE session_id = ? AND kind = 'point' ORDER BY id", session.id),
      notes: student ? [] : notesOf(session.id),
    });
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
   * The lecture this conversation is about: the one given by id (from a "continue in Ask Campus" link), else one
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
    const record = load(session, lecturer ? { audience: 'lecturer' } : { audience: 'student', studentId: user.id });
    return recordText({ ...record, notes: [] });
  }

  return { load, find, contextFor, lecturesOf };
}

module.exports = { createRecordSource };
