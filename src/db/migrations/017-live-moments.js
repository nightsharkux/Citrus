'use strict';
/**
 * What the lecturer needs afterwards: the moments the class got lost (with a short excerpt of what was being said and a
 * one-sentence note on the likely sticking point) and the key points the assistant picked up while listening. These are
 * the only pieces of speech ever stored; the rest of the lecture is never kept (src/modules/live/transcript.js).
 */
module.exports = {
  version: 17,
  name: 'live-moments',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_moments(
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('struggle','point')),
        minute INTEGER NOT NULL,
        answered INTEGER NOT NULL DEFAULT 0,
        lost INTEGER NOT NULL DEFAULT 0,
        unsure INTEGER NOT NULL DEFAULT 0,
        excerpt TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_live_moments ON live_moments(session_id, kind, minute);
    `);
  },
};
