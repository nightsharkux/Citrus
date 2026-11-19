'use strict';
/**
 * Breaks and chapters of a live lecture.
 *
 *   live_breaks    every pause of a lecture (a coffee break, a long break): when it began and, once it is over, when
 *                  it ended. While one is open the lecture is "on a break": students cannot answer, nothing is
 *                  heard, and the break time is left out of the lecture's minutes (src/modules/live/breaks.js).
 *   live_chapters  where the lecturer marked a new chapter, like a lap on a stopwatch. A chapter runs from its mark
 *                  to the next one; the first starts with the lecture. The title is added later, if at all.
 *   live_sessions.paused_at  the start of the open break, or NULL.
 */
const { addColumn } = require('../helpers');

module.exports = {
  version: 27,
  name: 'breaks-and-chapters',
  up(db) {
    addColumn(db, 'live_sessions', 'paused_at', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_breaks(
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        started TEXT NOT NULL,
        ended TEXT);
      CREATE INDEX IF NOT EXISTS idx_live_breaks ON live_breaks(session_id, started);
      CREATE TABLE IF NOT EXISTS live_chapters(
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        started TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_live_chapters ON live_chapters(session_id, started);
    `);
  },
};
