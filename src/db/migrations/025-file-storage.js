'use strict';
/**
 * Files and recordings kept in file storage (Vercel Blob, src/services/blob.js) when the project has a store: the
 * address of each stored course file and meeting recording, and the background audio of live lectures from the
 * Android app, piece by piece. Without a store nothing changes: these stay empty.
 */
const { addColumn } = require('../helpers');

module.exports = {
  version: 25,
  name: 'file-storage',
  up(db) {
    addColumn(db, 'course_items', 'blob_url', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'meeting_recordings', 'blob_url', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'meeting_recordings', 'duration_ms', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_recordings(
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        blob_url TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_live_recordings ON live_recordings(session_id, recorded_at);
    `);
  },
};
