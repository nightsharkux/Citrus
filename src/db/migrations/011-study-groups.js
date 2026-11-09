'use strict';
/**
 * Study-group requests (src/modules/groups): "I am looking for a group for Mathe 2". Other students see the request
 * and are matched with it; name and e-mail are shown only when the person agreed to share them (share_contact).
 */
module.exports = {
  version: 11,
  name: 'study-groups',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS study_group_requests(
        id INTEGER PRIMARY KEY,
        institution_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
        note TEXT NOT NULL DEFAULT '',
        share_contact INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        created TEXT NOT NULL,
        updated TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_study_groups_open ON study_group_requests(institution_id, status);
      CREATE INDEX IF NOT EXISTS idx_study_groups_user ON study_group_requests(user_id);
      CREATE TABLE IF NOT EXISTS assistant_memories(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_assistant_memories_user ON assistant_memories(user_id, id);
    `);
  },
};
