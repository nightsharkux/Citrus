'use strict';
/**
 * Tools people make for themselves ("Make a tool"): a small page the AI writes from a description, such as a big
 * clock for the projector or a group picker. Private to its maker until it is shared and an administrator approves
 * it; then anyone at the university can add it from "More tools".
 */
module.exports = {
  version: 22,
  name: 'custom-tools',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS custom_tools(
        id INTEGER PRIMARY KEY,
        institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
        owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT 'layers',
        idea TEXT NOT NULL DEFAULT '',
        html TEXT NOT NULL,
        look TEXT NOT NULL DEFAULT 'glass',
        visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','pending','public','rejected')),
        review_note TEXT NOT NULL DEFAULT '',
        created TEXT NOT NULL,
        updated TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_custom_tools ON custom_tools(institution_id, visibility);
      CREATE TABLE IF NOT EXISTS custom_tool_adds(
        tool_id INTEGER NOT NULL REFERENCES custom_tools(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        added TEXT NOT NULL,
        PRIMARY KEY (tool_id, user_id));
    `);
  },
};
