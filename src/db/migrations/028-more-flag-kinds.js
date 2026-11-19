'use strict';
/**
 * Two more ways for a student to flag a moment, both about how the lecture feels rather than what it says:
 * "long" (the explanation is going on much too long) and "boring". Some lecturers want to see exactly that.
 *
 * A column's CHECK list cannot be changed in place, so live_flags is rebuilt with the wider list and every row is
 * copied over. Flags already stored keep their ids, so nothing that points at them breaks.
 */
module.exports = {
  version: 28,
  name: 'more-flag-kinds',
  up(db) {
    const stored = db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'live_flags'")?.sql || '';
    if (stored.includes("'boring'")) return; // already rebuilt
    db.exec(`
      CREATE TABLE live_flags_wide(
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('confused','fast','example','question','long','boring')),
        minute INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        explanation TEXT NOT NULL DEFAULT '',
        created TEXT NOT NULL);
      INSERT INTO live_flags_wide(id, session_id, user_id, kind, minute, note, explanation, created)
        SELECT id, session_id, user_id, kind, minute, note, explanation, created FROM live_flags;
      DROP TABLE live_flags;
      ALTER TABLE live_flags_wide RENAME TO live_flags;
      CREATE INDEX IF NOT EXISTS idx_live_flags ON live_flags(session_id, minute);
    `);
  },
};
