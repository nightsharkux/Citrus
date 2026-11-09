'use strict';
/**
 * Live lectures: a session per lecture, the signals students send during it, and the notes (pictures, PDFs) the
 * lecturer attached. The spoken transcript is deliberately not stored here (see src/modules/live/transcript.js).
 */
module.exports = {
  version: 14,
  name: 'live-lectures',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_sessions(
        id INTEGER PRIMARY KEY,
        institution_id INTEGER NOT NULL,
        course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        lecturer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        started TEXT NOT NULL,
        ended TEXT);
      CREATE INDEX IF NOT EXISTS idx_live_course ON live_sessions(course_id, ended);
      CREATE TABLE IF NOT EXISTS live_signals(
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        level INTEGER NOT NULL CHECK(level IN (1,2,3)),
        created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_live_signals ON live_signals(session_id, created);
      CREATE TABLE IF NOT EXISTS live_notes(
        session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        attachment_id INTEGER NOT NULL REFERENCES assistant_attachments(id) ON DELETE CASCADE,
        PRIMARY KEY (session_id, attachment_id));
    `);
  },
};
