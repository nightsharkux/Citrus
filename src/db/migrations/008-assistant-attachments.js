'use strict';
/**
 * Files and pictures attached to assistant messages. Images keep their (already
 * downsized) bytes so the model can look at them again in follow-up questions;
 * documents keep the text read from them. Unsent uploads have no message yet.
 */
module.exports = {
  version: 8,
  name: 'assistant-attachments',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_attachments(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id INTEGER REFERENCES assistant_messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('image','document')),
        name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON assistant_attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_user ON assistant_attachments(user_id, message_id);
    `);
  },
};
