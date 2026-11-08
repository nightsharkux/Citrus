'use strict';
/**
 * Lecture insights: key points picked out of live captions while a lecture runs,
 * what students saved or found unclear, and the study notes made afterwards.
 */
module.exports = {
  version: 7,
  name: 'lecture-insights',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lecture_insights(
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', formula TEXT NOT NULL DEFAULT '',
        importance INTEGER NOT NULL DEFAULT 2, topic TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'ai',
        from_caption INTEGER NOT NULL DEFAULT 0, to_caption INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_insights_ws ON lecture_insights(workspace_id, id);

      CREATE TABLE IF NOT EXISTS lecture_insight_marks(
        insight_id INTEGER NOT NULL REFERENCES lecture_insights(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mark TEXT NOT NULL CHECK (mark IN ('saved', 'unclear')), created TEXT NOT NULL,
        PRIMARY KEY(insight_id, user_id, mark));

      CREATE TABLE IF NOT EXISTS lecture_insight_state(
        workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        last_caption INTEGER NOT NULL DEFAULT 0, running_since INTEGER NOT NULL DEFAULT 0,
        last_run INTEGER NOT NULL DEFAULT 0, topic TEXT NOT NULL DEFAULT '');

      CREATE TABLE IF NOT EXISTS lecture_digests(
        workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        summary TEXT NOT NULL, glossary TEXT NOT NULL DEFAULT '[]', questions TEXT NOT NULL DEFAULT '[]', follow_ups TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL, author_id INTEGER, created TEXT NOT NULL);
    `);
  },
};
