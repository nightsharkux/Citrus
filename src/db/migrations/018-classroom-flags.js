'use strict';
/**
 * The classroom loop, made easier to join and more useful afterwards:
 *
 *   join_code        six digits the lecturer shows on the projector; students type it to join (and enrol)
 *   keep_transcript  the lecturer chose to keep what Citrus heard, so Citrus can answer about the lecture later.
 *                    Off for every session started before this migration (they were never stored).
 *   live_transcript  what Citrus heard, per minute, only for sessions with keep_transcript
 *   live_flags       a student marks a moment ("didn't get this", "too fast", "need an example", a question), with an
 *                    optional note. The lecturer sees them without names; the student gets an explanation later.
 *   live_attendees   who opened the lecture, so the lecturer sees how many are in the room
 */
const { addColumn } = require('../helpers');

module.exports = {
  version: 18,
  name: 'classroom-flags',
  up(db) {
    addColumn(db, 'live_sessions', 'join_code', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'live_sessions', 'keep_transcript', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_live_join ON live_sessions(institution_id, join_code, ended);
      CREATE TABLE IF NOT EXISTS live_transcript(
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        minute INTEGER NOT NULL,
        text TEXT NOT NULL,
        created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_live_transcript ON live_transcript(session_id, minute);
      CREATE TABLE IF NOT EXISTS live_flags(
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('confused','fast','example','question')),
        minute INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        explanation TEXT NOT NULL DEFAULT '',
        created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_live_flags ON live_flags(session_id, minute);
      CREATE TABLE IF NOT EXISTS live_attendees(
        session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined TEXT NOT NULL,
        PRIMARY KEY (session_id, user_id));
    `);
  },
};
