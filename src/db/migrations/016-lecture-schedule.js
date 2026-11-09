'use strict';
/**
 * Lectures get a time and a room, and a live session belongs to a lecture, so students see one list of lectures:
 * live now, coming up, and recent.
 */
const { addColumn } = require('../helpers');

module.exports = {
  version: 16,
  name: 'lecture-schedule',
  up(db) {
    addColumn(db, 'lectures', 'starts', 'TEXT');
    addColumn(db, 'lectures', 'ends', 'TEXT');
    addColumn(db, 'lectures', 'room', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'live_sessions', 'lecture_id', 'INTEGER REFERENCES lectures(id) ON DELETE SET NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_lectures_starts ON lectures(starts)');
  },
};
